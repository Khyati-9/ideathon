import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer } from 'node:http';

/*
 * KaamSetu WhatsApp bot
 *
 * This is intentionally dependency-free so it can run beside the existing API.
 * In production set the WHATSAPP_* variables below and expose /whatsapp/webhook
 * over HTTPS. With BOT_DRY_RUN=true it becomes a local simulator.
 */

const port = Number(process.env.PORT || process.env.WHATSAPP_BOT_PORT || 8787);
const backendUrl = (process.env.KAAMSETU_API_URL || 'https://kaamsetu.phala.work/api').replace(/\/$/, '');
const graphVersion = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'change-this-verify-token';
const appSecret = process.env.WHATSAPP_APP_SECRET || '';
const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '';
const dryRun = process.env.BOT_DRY_RUN === 'true' || !phoneNumberId || !accessToken;
const campaignDataFile = process.env.CAMPAIGN_DATA_FILE || './data/whatsapp-campaigns.json';

const sessions = new Map();
const processedMessageIds = new Set();
let campaignStore = { campaigns: [], messages: [], flows: [] };
let campaignStoreReady;

async function loadCampaignStore() {
  if (campaignStoreReady) return campaignStoreReady;
  campaignStoreReady = (async () => {
    try { campaignStore = JSON.parse(await readFile(campaignDataFile, 'utf8')); }
    catch { campaignStore = { campaigns: [], messages: [] }; }
    campaignStore.campaigns ||= [];
    campaignStore.messages ||= [];
    campaignStore.flows ||= [];
    return campaignStore;
  })();
  return campaignStoreReady;
}
async function saveCampaignStore() {
  await mkdir(dirname(campaignDataFile), { recursive: true }).catch(() => {});
  await writeFile(campaignDataFile, JSON.stringify(campaignStore, null, 2));
}
async function saveFlow(input) {
  await loadCampaignStore();
  if (!input.name || !Array.isArray(input.nodes) || !input.nodes.length) throw new Error('Flow name and at least one node are required');
  const flow = { flow_id: input.flow_id || randomUUID(), name: input.name, nodes: input.nodes, updated_at: isoNow() };
  campaignStore.flows = campaignStore.flows.filter(item => item.flow_id !== flow.flow_id && item.name !== flow.name);
  campaignStore.flows.unshift(flow); await saveCampaignStore(); return flow;
}
async function routeFlowButton(phone, message) {
  const buttonId = message?.interactive?.button_reply?.id || message?.interactive?.list_reply?.id;
  if (!buttonId) return false;
  await loadCampaignStore();
  for (const flow of campaignStore.flows) {
    const node = flow.nodes.find(item => item.buttons?.some(button => button.id === buttonId));
    const button = node?.buttons?.find(item => item.id === buttonId);
    if (button?.next) {
      const next = flow.nodes.find(item => item.id === button.next);
      if (next) {
        await sendFlowNode(phone, flow, next.id);
        return true;
      }
    }
  }
  return false;
}
async function sendFlowNode(phone, flow, nodeId) {
  const node = flow.nodes.find(item => item.id === nodeId);
  if (!node) throw new Error(`Flow node not found: ${nodeId}`);
  if (node.buttons?.length) return buttons(phone, node.text, node.buttons.slice(0, 3).map(item => ({ id: item.id, title: item.title })));
  return sendWhatsApp(phone, node.text);
}
async function startFlow(phone, flowId) {
  await loadCampaignStore();
  const flow = campaignStore.flows.find(item => item.flow_id === flowId || item.name === flowId);
  if (!flow || !flow.nodes.length) throw new Error('Flow not found or empty');
  await sendFlowNode(phone, flow, flow.nodes[0].id);
  return { ok: true, flow_id: flow.flow_id, started_at: isoNow(), phone: normalizePhone(phone) };
}
const normalizePhone = value => String(value || '').replace(/\D/g, '').replace(/^0+/, '');
const isoNow = () => new Date().toISOString();
const body = request => new Promise((resolve, reject) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});

const languageText = {
  en: {
    welcome: 'Welcome to KaamSetu! Choose your language.',
    language: '1. Marathi\n2. Hindi\n3. English',
    role: 'What are you looking for?',
    farmer: 'Looking for workers', worker: 'Looking for work',
    farmerMenu: 'Choose an option:', post: 'Post work', browseWorkers: 'Explore workers', myProfile: 'My profile',
    workerMenu: 'Choose an option:', findWork: 'Find work', availability: 'Post my availability', browseJobs: 'Explore jobs',
    reset: 'Start again', back: 'Back', cancel: 'Cancel',
    askName: 'What is your name?', askTaluka: 'Which taluka are you in?', askVillage: 'Which village are you in?',
    askCategory: 'Choose the work category.', askActivities: 'Choose activities. Reply with numbers separated by commas.\n1. Tomato picking\n2. Onion harvesting\n3. Grape harvesting\n4. Planting\n5. Weeding\n6. Spraying\n7. Packing / warehouse\n8. Loading / unloading\n9. Other',
    askOther: 'Tell us the work in a few words.', askDate: 'What date is the work? Reply YYYY-MM-DD.', askCount: 'How many people are needed? You can reply 5, or skip with 0.', askWage: 'What wage is offered? Reply with the amount, for example 600.', askUnit: 'Choose the payment type: 1. Per day  2. Per crate  3. Per acre  4. Fixed work amount',
    askType: 'Are you an individual or a team? 1. Individual  2. Team', askTeamSize: 'How many people are in the team?', askSkills: 'Choose your skills. Reply with numbers separated by commas.\n1. Tomato picking\n2. Onion harvesting\n3. Grape harvesting\n4. Planting\n5. Weeding\n6. Spraying\n7. Packing / warehouse\n8. Loading / unloading\n9. Other', askExpected: 'What wage do you expect? Reply with the amount.', askAvailability: 'When are you available? 1. Now  2. This week  3. From a date', askAvailableDate: 'Reply with your available date as YYYY-MM-DD.',
    confirm: 'Please check these details:\n{summary}\n\n1. Confirm\n2. Start again', posted: 'Posted successfully. I am checking nearby matches now.', saved: 'Your work profile is saved. I am checking nearby jobs now.', noMatches: 'No exact village match yet. I will also check the same taluka.',
    matchesWorkers: 'Matching workers:', matchesJobs: 'Matching jobs:', bid: 'Bid / send offer', accept: 'Accept', counter: 'Send counter offer', decline: 'Decline', offerWage: 'What amount do you want to offer?', offerSent: 'Offer sent. The other person will be notified.', pending: 'This action is ready, but the backend still needs the offers/booking endpoint.',
    help: 'Reply with a number, or type MENU to start again.', invalid: 'I did not understand that. Reply with one of the options shown.', private: 'Phone numbers stay private. Only name, location, skills, date and wage are shown.'
  },
  mr: {
    welcome: 'KaamSetu मध्ये स्वागत! भाषा निवडा.', language: '१. मराठी\n२. हिंदी\n३. इंग्रजी', role: 'आज तुम्हाला काय हवं आहे?', farmer: 'शेतकरी', worker: 'कामगार', farmerMenu: 'पर्याय निवडा:', post: 'काम पोस्ट करा', browseWorkers: 'कामगार शोधा', myProfile: 'माझं प्रोफाइल', workerMenu: 'पर्याय निवडा:', findWork: 'काम शोधा', availability: 'माझी उपलब्धता पोस्ट करा', browseJobs: 'काम शोधा', reset: 'पुन्हा सुरू करा', back: 'मागे', cancel: 'रद्द करा', askName: 'तुमचं नाव काय?', askTaluka: 'तुमचा तालुका कोणता?', askVillage: 'तुमचं गाव कोणतं?', askCategory: 'कामाची श्रेणी निवडा.', askActivities: 'कामं निवडा. स्वल्पविरामाने क्रमांक पाठवा.\n१. टोमॅटो तोडणी\n२. कांदा काढणी\n३. द्राक्ष काढणी\n४. लागवड\n५. खुरपणी\n६. फवारणी\n७. पॅकिंग / गोदाम\n८. लोडिंग / अनलोडिंग\n९. इतर', askOther: 'काम काही शब्दांत सांगा.', askDate: 'कामाची तारीख कोणती? YYYY-MM-DD पाठवा.', askCount: 'किती कामगार हवेत? उदा. ५, किंवा ० पाठवा.', askWage: 'मजुरी किती देणार? उदा. ६००.', askUnit: 'पेमेंट प्रकार: १. प्रतिदिन  २. प्रति क्रेट  ३. प्रति एकर  ४. पूर्ण कामाची रक्कम', askType: 'तुम्ही वैयक्तिक आहात की टीम? १. वैयक्तिक  २. टीम', askTeamSize: 'टीममध्ये किती लोक आहेत?', askSkills: 'तुमची कौशल्यं निवडा. क्रमांक स्वल्पविरामाने पाठवा.\n१. टोमॅटो तोडणी\n२. कांदा काढणी\n३. द्राक्ष काढणी\n४. लागवड\n५. खुरपणी\n६. फवारणी\n७. पॅकिंग / गोदाम\n८. लोडिंग / अनलोडिंग\n९. इतर', askExpected: 'तुम्हाला किती मजुरी हवी?', askAvailability: 'कधी उपलब्ध आहात? १. आता  २. या आठवड्यात  ३. तारखेपासून', askAvailableDate: 'उपलब्धतेची तारीख YYYY-MM-DD पाठवा.', confirm: 'माहिती तपासा:\n{summary}\n\n१. निश्चित करा\n२. पुन्हा सुरू करा', posted: 'काम यशस्वीपणे पोस्ट झालं. जवळचे कामगार शोधत आहे.', saved: 'तुमचं प्रोफाइल जतन झालं. जवळचं काम शोधत आहे.', noMatches: 'याच गावात जुळणी नाही. त्याच तालुक्यातही शोधत आहे.', matchesWorkers: 'जुळणारे कामगार:', matchesJobs: 'जुळणारी कामं:', bid: 'बोली / ऑफर पाठवा', accept: 'स्वीकारा', counter: 'नवी बोली पाठवा', decline: 'नकार', offerWage: 'तुम्ही किती रक्कम देऊ/घेऊ इच्छिता?', offerSent: 'ऑफर पाठवली. समोरच्या व्यक्तीला कळवलं आहे.', pending: 'ही कृती तयार आहे, पण offers/booking backend endpoint अजून जोडायचा आहे.', help: 'क्रमांक पाठवा किंवा MENU लिहा.', invalid: 'समजलं नाही. दाखवलेल्या पर्यायांपैकी एक निवडा.', private: 'फोन नंबर खाजगी राहतील. फक्त नाव, ठिकाण, कौशल्य, तारीख आणि मजुरी दिसेल.'
  },
  hi: {
    welcome: 'KaamSetu में स्वागत है! भाषा चुनें.', language: '1. मराठी\n2. हिंदी\n3. अंग्रेज़ी', role: 'आज आपको क्या चाहिए?', farmer: 'किसान', worker: 'मज़दूर', farmerMenu: 'विकल्प चुनें:', post: 'काम पोस्ट करें', browseWorkers: 'मज़दूर खोजें', myProfile: 'मेरी प्रोफ़ाइल', workerMenu: 'विकल्प चुनें:', findWork: 'काम खोजें', availability: 'अपनी उपलब्धता पोस्ट करें', browseJobs: 'काम खोजें', reset: 'फिर से शुरू करें', back: 'पीछे', cancel: 'रद्द करें', askName: 'आपका नाम क्या है?', askTaluka: 'आपकी तहसील कौन सी है?', askVillage: 'आपका गाँव कौन सा है?', askCategory: 'काम की श्रेणी चुनें.', askActivities: 'काम चुनें. कॉमा से नंबर भेजें.\n1. टमाटर तोड़ना\n2. प्याज़ की कटाई\n3. अंगूर की कटाई\n4. रोपाई\n5. निराई\n6. छिड़काव\n7. पैकिंग / गोदाम\n8. लोडिंग / अनलोडिंग\n9. अन्य', askOther: 'काम कुछ शब्दों में बताएं.', askDate: 'काम की तारीख बताएं. YYYY-MM-DD भेजें.', askCount: 'कितने मज़दूर चाहिए? जैसे 5, या 0 भेजें.', askWage: 'कितनी मज़दूरी देंगे? जैसे 600.', askUnit: 'भुगतान प्रकार: 1. प्रतिदिन  2. प्रति क्रेट  3. प्रति एकड़  4. पूरे काम की रकम', askType: 'आप अकेले हैं या टीम? 1. अकेले  2. टीम', askTeamSize: 'टीम में कितने लोग हैं?', askSkills: 'अपने कौशल चुनें. कॉमा से नंबर भेजें.\n1. टमाटर तोड़ना\n2. प्याज़ की कटाई\n3. अंगूर की कटाई\n4. रोपाई\n5. निराई\n6. छिड़काव\n7. पैकिंग / गोदाम\n8. लोडिंग / अनलोडिंग\n9. अन्य', askExpected: 'आपकी अपेक्षित मज़दूरी कितनी है?', askAvailability: 'कब उपलब्ध हैं? 1. अभी  2. इस हफ्ते  3. किसी तारीख से', askAvailableDate: 'उपलब्ध तारीख YYYY-MM-DD भेजें.', confirm: 'जानकारी जाँचें:\n{summary}\n\n1. पुष्टि करें\n2. फिर से शुरू करें', posted: 'काम सफलतापूर्वक पोस्ट हुआ. पास के मज़दूर खोज रहा हूँ.', saved: 'आपकी प्रोफ़ाइल सेव है. पास का काम खोज रहा हूँ.', noMatches: 'इसी गाँव में मैच नहीं मिला. उसी तहसील में भी खोज रहा हूँ.', matchesWorkers: 'मिलते-जुलते मज़दूर:', matchesJobs: 'मिलते-जुलते काम:', bid: 'बोली / ऑफर भेजें', accept: 'स्वीकार करें', counter: 'दूसरी बोली भेजें', decline: 'मना करें', offerWage: 'आप कितनी रकम देना/लेना चाहते हैं?', offerSent: 'ऑफर भेज दी. सामने वाले को सूचना मिल गई है.', pending: 'यह कार्रवाई तैयार है, लेकिन offers/booking backend endpoint अभी जोड़ना बाकी है.', help: 'नंबर भेजें या MENU लिखें.', invalid: 'समझ नहीं आया. दिखाए गए विकल्पों में से एक चुनें.', private: 'फोन नंबर निजी रहेंगे. केवल नाम, जगह, कौशल, तारीख और मज़दूरी दिखेगी.'
  }
};

const skills = ['Tomato picking', 'Onion harvesting', 'Grape harvesting', 'Planting', 'Weeding', 'Spraying', 'Packing / warehouse', 'Loading / unloading'];
const t = (session, key) => languageText[session.lang || 'en'][key] || languageText.en[key];
const normalizeChoice = value => String(value || '').trim().toLowerCase();
const numeric = value => Number(String(value || '').replace(/[^0-9.]/g, '')) || 0;
const parseIndexes = (text, length) => String(text).split(/[,\s]+/).map(value => Number(value) - 1).filter(index => index >= 0 && index < length);
const selectedSkills = (text, other) => [...new Set(parseIndexes(text, skills.length + 1).map(index => index === skills.length ? (other || 'Other') : skills[index]))];
const units = ['daily', 'crate', 'acre', 'task'];

function getSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, { phone, lang: null, role: null, step: 'language', draft: {} });
  return sessions.get(phone);
}
function resetSession(phone) {
  const next = { phone, lang: null, role: null, step: 'language', draft: {} };
  sessions.set(phone, next);
  return next;
}
function setStep(session, step) { session.step = step; }
function summary(session) {
  const d = session.draft;
  if (session.role === 'farmer') return [
    `Name: ${d.name}`, `Location: ${d.village}, ${d.taluka}`, `Activities: ${(d.activities || []).join(', ')}`,
    `Date: ${d.date}`, `Workers: ${d.count || 0}`, `Wage: ₹${d.wage} / ${d.payment_unit}`
  ].join('\n');
  return [`Name: ${d.name}`, `Location: ${d.village}, ${d.taluka}`, `Type: ${d.type}`, `Skills: ${(d.skills || []).join(', ')}`, `Expected wage: ₹${d.wage} / ${d.payment_unit}`, `Availability: ${d.availability || d.available_from}`].join('\n');
}

async function backend(path, options = {}) {
  const response = await fetch(`${backendUrl}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const text = await response.text();
  let value = {};
  try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
  if (!response.ok) throw new Error(value.error || value.detail || `Backend returned ${response.status}`);
  return value;
}
async function saveProfile(session) {
  const d = session.draft;
  if (session.role === 'farmer') return backend('/farmer/', { method: 'POST', body: JSON.stringify({
    phone: session.phone, name: d.name, taluka: d.taluka, village: d.village, category: d.category || 'agriculture',
    jobType: d.activities?.[0] || 'Other work', activities: d.activities, count: d.count, date: d.date, wageOffer: d.wage, payMethod: d.payment_unit
  }) });
  return backend('/labour/', { method: 'POST', body: JSON.stringify({
    phone: session.phone, name: d.name, taluka: d.taluka, village: d.village, type: d.type, teamSize: d.team_size,
    skills: d.skills, preferredWork: d.skills?.[0] || 'Other work', wageAsk: d.wage, availability: d.availability, date: d.available_from, paymentMethod: d.payment_unit
  }) });
}
async function findMatches(session) {
  const d = session.draft;
  if (session.role === 'farmer') {
    const jobs = await backend(`/workers/explore/?limit=5&taluka=${encodeURIComponent(d.taluka)}&skill=${encodeURIComponent((d.activities || []).join(','))}`);
    return (jobs.workers || []).map(worker => `${worker.name || 'Worker'} · ${worker.village || worker.taluka || d.taluka} · ₹${worker.expected_wage || '—'}/day\nSkills: ${(worker.skills || []).slice(0, 3).join(', ') || '—'}\nReply BID ${worker.labour_id || worker.id} to send an offer.`);
  }
  const jobs = await backend(`/jobs/explore/?limit=5&taluka=${encodeURIComponent(d.taluka)}&skill=${encodeURIComponent((d.skills || []).join(','))}`);
  return (jobs.jobs || []).map(job => `${job.job_type || job.category || 'Work'} · ${job.village || job.taluka || d.taluka}\nDate: ${job.work_date || '—'} · ₹${job.wage_offered || '—'}/${job.payment_method || 'day'}\nReply BID ${job.job_id} to send your bid.`);
}

async function sendTemplate(to, templateName, language = 'en_US', components = []) {
  if (dryRun) return { dryRun: true, messages: [{ id: `dryrun.${randomUUID()}` }] };
  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: normalizePhone(to), type: 'template', template: { name: templateName, language: { code: language }, ...(components.length ? { components } : {}) } })
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || 'WhatsApp template send failed');
  return value;
}
async function graphRequest(path, options = {}) {
  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${path}`, {
    ...options,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || `Meta Graph API returned ${response.status}`);
  return value;
}
async function createTemplate(input) {
  if (!businessAccountId) throw new Error('WHATSAPP_BUSINESS_ACCOUNT_ID is not configured');
  if (!input.name || !input.language || !input.category) throw new Error('name, language and category are required');
  return graphRequest(`${businessAccountId}/message_templates`, { method: 'POST', body: JSON.stringify({ name: input.name, language: input.language, category: input.category, components: input.components || [] }) });
}
async function listTemplates() {
  if (!businessAccountId) throw new Error('WHATSAPP_BUSINESS_ACCOUNT_ID is not configured');
  return graphRequest(`${businessAccountId}/message_templates?limit=100`);
}
function operationsHtml() {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>KaamSetu WhatsApp Operations</title><style>body{font:16px system-ui;max-width:1000px;margin:auto;padding:24px;background:#f7f3e9;color:#123f31}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.card{background:#fffdf7;border:1px solid #d9dfd4;border-radius:16px;padding:18px}label{display:block;font-weight:700;margin:10px 0 4px}input,select,textarea{box-sizing:border-box;width:100%;padding:10px;border:1px solid #ccd6cb;border-radius:8px;font:inherit}textarea{min-height:80px}button{margin-top:12px;padding:11px 15px;border:0;border-radius:8px;background:#ff765b;font-weight:700;cursor:pointer}pre{white-space:pre-wrap;max-height:260px;overflow:auto;background:#edf3e8;padding:10px;border-radius:8px}.wide{grid-column:1/-1}</style><h1>KaamSetu WhatsApp Operations</h1><p>Developer-only dashboard; not linked from the public website.</p><div class="grid"><section class="card"><h2>Create template</h2><label>Name</label><input id="tn" placeholder="kaamsetu_welcome"><label>Language</label><input id="tl" value="en_US"><label>Category</label><select id="tc"><option>UTILITY</option><option>MARKETING</option><option>AUTHENTICATION</option></select><label>Body</label><textarea id="tb" placeholder="Welcome to KaamSetu. Reply Hi to begin."></textarea><button onclick="createTemplate()">Submit template</button><pre id="tout"></pre></section><section class="card"><h2>Build bot flow</h2><label>Flow name</label><input id="fn" value="default_customer_flow"><label>Steps, one per line</label><textarea id="fs">Hi → Choose language\nChoose work or workers\nCollect profile details\nShow matches\nSend offer</textarea><button onclick="saveFlow()">Save flow draft</button><pre id="fout"></pre></section><section class="card wide"><h2>Send campaign</h2><label>Campaign name</label><input id="cn" placeholder="Tomato harvest update"><label>Approved template name</label><input id="ct" placeholder="tomato_harvest_update"><label>Recipients, one phone per line</label><textarea id="cr" placeholder="9193332780"></textarea><label>Components JSON (optional)</label><textarea id="cc" placeholder="[]"></textarea><button onclick="sendCampaign()">Create and send</button><pre id="cout"></pre></section><section class="card wide"><h2>Campaign analytics</h2><button onclick="loadAnalytics()">Refresh</button><pre id="aout">Loading...</pre></section></div><script>const out=(i,v)=>document.getElementById(i).textContent=typeof v==='string'?v:JSON.stringify(v,null,2);async function api(p,o){const r=await fetch(p,{headers:{'content-type':'application/json'},...o});const v=await r.json().catch(()=>({error:r.statusText}));if(!r.ok)throw Error(v.error||r.statusText);return v}async function createTemplate(){try{out('tout',await api('/whatsapp/ops/templates',{method:'POST',body:JSON.stringify({name:tn.value,language:tl.value,category:tc.value,components:[{type:'BODY',text:tb.value}]})}))}catch(e){out('tout',e.message)}}function saveFlow(){const v={name:fn.value,steps:fs.value.split('\\n').filter(Boolean),saved_at:new Date().toISOString()};localStorage.setItem('kaamsetu-flow',JSON.stringify(v));out('fout',v)}async function sendCampaign(){try{out('cout',await api('/whatsapp/ops/campaigns',{method:'POST',body:JSON.stringify({name:cn.value,template_name:ct.value,language:'en_US',recipients:cr.value.split(/\\s+/).filter(Boolean),components:JSON.parse(cc.value||'[]'),launch:true})}))}catch(e){out('cout',e.message)}}async function loadAnalytics(){try{out('aout',await api('/whatsapp/ops/campaigns'))}catch(e){out('aout',e.message)}}loadAnalytics();</script>`;
}
function builderHtml() {
  return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>KaamSetu Flow Builder</title><style>body{font:16px system-ui;max-width:900px;margin:auto;padding:24px;background:#f7f3e9;color:#123f31}.card{background:#fffdf7;border:1px solid #d9dfd4;border-radius:16px;padding:20px;margin:16px 0}input,textarea{box-sizing:border-box;width:100%;padding:11px;margin:6px 0 14px;border:1px solid #ccd6cb;border-radius:8px;font:inherit}textarea{min-height:110px}button{padding:11px 15px;border:0;border-radius:8px;background:#ff765b;font-weight:700}</style><h1>Flow builder</h1><p>Create the customer flow, button choices, and attach it to a campaign.</p><section class="card"><label>Flow name</label><input id="name" value="default_customer_flow"><label>Steps, one per line</label><textarea id="steps">Hi → Choose language\nChoose role\nCollect details\nShow matches</textarea><label>Buttons, one per line: button text → next step</label><textarea id="buttons">Looking for work → worker_flow\nLooking for workers → farmer_flow</textarea><button onclick="save()">Save flow</button><pre id="out"></pre></section><script>function save(){const v={name:name.value,steps:steps.value.split(/\\n/).filter(Boolean),buttons:buttons.value.split(/\\n/).filter(Boolean),saved_at:new Date().toISOString()};localStorage.setItem("kaamsetu-flow",JSON.stringify(v));out.textContent=JSON.stringify(v,null,2)}</script>';
}
function builderHtmlV2() {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>KaamSetu Automation Flow Builder</title><style>body{font:16px system-ui;max-width:950px;margin:auto;padding:24px;background:#f7f3e9;color:#123f31}.card{background:#fffdf7;border:1px solid #d9dfd4;border-radius:16px;padding:20px;margin:16px 0}input,textarea{box-sizing:border-box;width:100%;padding:11px;margin:6px 0 12px;border:1px solid #ccd6cb;border-radius:8px;font:inherit}textarea{min-height:110px}button{padding:11px 15px;border:0;border-radius:8px;background:#ff765b;font-weight:700}.hint{color:#68766e}.node{border-left:5px solid #ff765b;padding-left:12px;margin:12px 0}</style><h1>Automation flow builder</h1><p class="hint">Each node is a WhatsApp message. Each button routes to the node ID written after the arrow.</p><section class="card"><label>Flow name</label><input id="n" value="worker_campaign_flow"><label>Nodes JSON</label><textarea id="j">[{"id":"welcome","text":"कामासाठी भटकंती बंद! आता थेट मोबाईलवर मिळवा काम!","buttons":[{"id":"start","title":"सुरू करा","next":"benefits"}]},{"id":"benefits","text":"आता तुमच्या मोबाईलवरूनच मिळवा रोज काम.\\n\\n• १००% मोफत नोंदणी\\n• तुमच्याच परिसरात / गावात काम\\n• वेळेवर आणि पूर्ण मजुरी","buttons":[{"id":"categories","title":"कामाचे प्रकार","next":"categories"}]},{"id":"categories","text":"कामाचे प्रकार / Categories\\nशेतीकाम | पॅकहाऊस | लोडिंग-अनलोडिंग | बांधकाम","buttons":[{"id":"contact","title":"WhatsApp करा","next":"contact"}]},{"id":"contact","text":"आजच मिस्ड कॉल द्या किंवा WhatsApp करा: 📞 तुमचा नंबर येथे टाका","buttons":[]}]</textarea><button onclick="save()">Save automation flow</button><pre id="o"></pre></section><script>async function save(){try{const v=JSON.parse(j.value);const r=await fetch('/whatsapp/ops/flows',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:n.value,nodes:v})});const x=await r.json();o.textContent=JSON.stringify(x,null,2)}catch(e){o.textContent=e.message}}</script>`;
}
function builderHtmlV3() {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>KaamSetu Flow Builder</title><style>body{font:16px system-ui;max-width:1000px;margin:auto;padding:24px;background:#f7f3e9;color:#123f31}.top,.node{background:#fffdf7;border:1px solid #d9dfd4;border-radius:16px;padding:18px;margin:14px 0;box-shadow:0 4px 14px #123f3112}input,textarea,select{box-sizing:border-box;width:100%;padding:10px;margin:5px 0 12px;border:1px solid #ccd6cb;border-radius:8px;font:inherit}textarea{min-height:75px}.node{border-left:6px solid #ff765b}.btn{display:grid;grid-template-columns:1.1fr 1fr 1fr auto;gap:8px;align-items:center}.btn input,.btn select{margin:0}.add,.save{padding:11px 15px;border:0;border-radius:8px;background:#ff765b;font-weight:800;cursor:pointer}.save{background:#125743;color:#fff}.remove{border:0;background:#eee;padding:8px;border-radius:7px;cursor:pointer}pre{white-space:pre-wrap;background:#edf3e8;padding:10px;border-radius:8px}@media(max-width:700px){.btn{grid-template-columns:1fr}.btn>*{margin-bottom:5px!important}}</style><h1>WhatsApp automation flow</h1><p>Build messages and connect each button to the next step visually.</p><div class="top"><label>Flow name</label><input id="flowName" value="worker_campaign_flow"><button class="add" onclick="addNode()">+ Add message step</button> <button class="save" onclick="saveFlow()">Save connected flow</button></div><div id="nodes"></div><pre id="result"></pre><script>let count=0;function addNode(data={}){count++;const id=data.id||'step_'+count;const el=document.createElement('section');el.className='node';el.dataset.id=id;el.innerHTML='<h2>Step '+count+'</h2><label>Step ID</label><input class="nid" value="'+id+'"><label>Message</label><textarea class="text">'+(data.text||'')+'</textarea><strong>Buttons</strong><div class="buttons"></div><button class="add" onclick="addButton(this)">+ Add button</button> <button class="remove" onclick="this.closest(\'.node\').remove()">Remove step</button>';document.getElementById('nodes').appendChild(el);(data.buttons||[]).forEach(b=>addButton(el.querySelector('.add'),b))}function addButton(button,data={}){const node=button.closest('.node');const row=document.createElement('div');row.className='btn';row.innerHTML='<input class="bid" placeholder="Button ID" value="'+(data.id||'')+'"><input class="btitle" placeholder="Button text" value="'+(data.title||'')+'"><select class="next"><option value="">Choose next step</option></select><button class="remove" onclick="this.parentElement.remove()">×</button>';node.querySelector('.buttons').appendChild(row);refreshSelects();if(data.next)row.querySelector('.next').value=data.next}function refreshSelects(){const ids=[...document.querySelectorAll('.node .nid')].map(x=>x.value);document.querySelectorAll('.next').forEach(s=>{const old=s.value;s.innerHTML='<option value="">Choose next step</option>'+ids.map(id=>'<option value="'+id+'">'+id+'</option>').join('');s.value=old})}async function saveFlow(){refreshSelects();const nodes=[...document.querySelectorAll('.node')].map(n=>({id:n.querySelector('.nid').value.trim(),text:n.querySelector('.text').value,buttons:[...n.querySelectorAll('.btn')].map(b=>({id:b.querySelector('.bid').value.trim(),title:b.querySelector('.btitle').value.trim(),next:b.querySelector('.next').value})).filter(b=>b.id&&b.title)}));try{const r=await fetch('/whatsapp/ops/flows',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:flowName.value,nodes})});result.textContent=JSON.stringify(await r.json(),null,2)}catch(e){result.textContent=e.message}}addNode({id:'welcome',text:'कामासाठी भटकंती बंद! आता थेट मोबाईलवर मिळवा काम!',buttons:[{id:'start',title:'सुरू करा',next:'benefits'}]});addNode({id:'benefits',text:'आता तुमच्या मोबाईलवरूनच मिळवा रोज काम.',buttons:[]});refreshSelects();</script>`;
}
function builderHtmlFixed() {
  return builderHtmlV3().replace("this.closest('.node').remove()", 'this.closest(&quot;.node&quot;).remove()');
}
function operationsHtmlV2() {
  return `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1"><title>KaamSetu WhatsApp Operations</title>
<style>body{font:16px system-ui;max-width:1100px;margin:auto;padding:24px;background:#f7f3e9;color:#123f31}h1{margin-bottom:4px}.sub{color:#68766e}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{background:#fffdf7;border:1px solid #d9dfd4;border-radius:18px;padding:20px;box-shadow:0 5px 18px #123f3112}.wide{grid-column:1/-1}label{display:block;font-weight:700;margin:12px 0 5px}input,select,textarea{box-sizing:border-box;width:100%;padding:11px;border:1px solid #ccd6cb;border-radius:9px;font:inherit}textarea{min-height:90px}button{margin-top:14px;padding:12px 16px;border:0;border-radius:9px;background:#ff765b;color:#123f31;font-weight:800;cursor:pointer}.green{background:#125743;color:#fff}.hint{font-size:13px;color:#68766e}pre{white-space:pre-wrap;max-height:260px;overflow:auto;background:#edf3e8;padding:12px;border-radius:9px}@media(max-width:700px){body{padding:14px}.grid{grid-template-columns:1fr}.wide{grid-column:auto}}</style>
<h1>KaamSetu WhatsApp Operations</h1><p class="sub">Templates, customer flows, buttons, campaigns and delivery analytics. This dashboard is not linked from the public website.</p>
<div class="grid">
<section class="card"><h2>1. Create template</h2><label>Template name</label><input id="tn2" placeholder="kaamsetu_welcome"><label>Language</label><input id="tl2" value="en_US"><label>Category</label><select id="tc2"><option>UTILITY</option><option>MARKETING</option><option>AUTHENTICATION</option></select><label>Message body</label><textarea id="tb2" placeholder="Welcome to KaamSetu. Reply Hi to begin."></textarea><button onclick="createTemplate2()">Submit template to Meta</button><pre id="tout2"></pre></section>
<section class="card"><h2>2. Build flow + buttons</h2><label>Flow name</label><input id="fn2" value="default_customer_flow"><label>Flow steps</label><textarea id="fs2">Hi → Choose language\nChoose role\nCollect profile details\nShow matches\nSend offer</textarea><label>Button options</label><textarea id="fb2">Looking for work → worker_flow\nLooking for workers → farmer_flow</textarea><p class="hint">Use one button per line: button text → next step.</p><button class="green" onclick="saveFlow2()">Save flow and buttons</button><pre id="fout2"></pre></section>
<section class="card wide"><h2>3. Campaign launcher</h2><label>Campaign name</label><input id="cn2" placeholder="Tomato harvest update"><label>Approved template name</label><input id="ct2" placeholder="tomato_harvest_update"><label>Recipients, one phone per line</label><textarea id="cr2" placeholder="9193332780"></textarea><label>Attach saved flow</label><select id="cf2"><option value="">No flow attached</option><option value="default_customer_flow">default_customer_flow</option></select><button onclick="sendCampaign2()">Launch campaign now</button><pre id="cout2"></pre></section>
<section class="card wide"><h2>4. Campaign analytics</h2><button class="green" onclick="loadAnalytics2()">Refresh analytics</button><pre id="aout2">Loading...</pre></section></div>
<script>const out2=(i,v)=>document.getElementById(i).textContent=typeof v==='string'?v:JSON.stringify(v,null,2);async function api2(p,o){const r=await fetch(p,{headers:{'content-type':'application/json'},...o});const v=await r.json().catch(()=>({error:r.statusText}));if(!r.ok)throw Error(v.error||r.statusText);return v}async function createTemplate2(){try{out2('tout2',await api2('/whatsapp/ops/templates',{method:'POST',body:JSON.stringify({name:tn2.value,language:tl2.value,category:tc2.value,components:[{type:'BODY',text:tb2.value}]})}))}catch(e){out2('tout2',e.message)}}function saveFlow2(){const v={name:fn2.value,steps:fs2.value.split('\\n').filter(Boolean),buttons:fb2.value.split('\\n').filter(Boolean),saved_at:new Date().toISOString()};localStorage.setItem('kaamsetu-flow',JSON.stringify(v));out2('fout2',v)}async function sendCampaign2(){try{const flow=JSON.parse(localStorage.getItem('kaamsetu-flow')||'null');out2('cout2',await api2('/whatsapp/ops/campaigns',{method:'POST',body:JSON.stringify({name:cn2.value,template_name:ct2.value,language:'en_US',recipients:cr2.value.split(/\\s+/).filter(Boolean),flow:flow?.name||cf2.value||null,launch:true})}))}catch(e){out2('cout2',e.message)}}async function loadAnalytics2(){try{out2('aout2',await api2('/whatsapp/ops/campaigns'))}catch(e){out2('aout2',e.message)}}loadAnalytics2();</script>`;
}
function campaignSummary(campaign) {
  return { ...campaign, messages: campaignStore.messages.filter(message => message.campaign_id === campaign.campaign_id) };
}
async function createCampaign(input) {
  await loadCampaignStore();
  const recipients = [...new Set((input.recipients || []).map(normalizePhone).filter(value => value.length >= 10))];
  if (!input.name || !input.template_name || !recipients.length) throw new Error('name, template_name and at least one recipient are required');
  const campaign = { campaign_id: randomUUID(), name: input.name, template_name: input.template_name, language: input.language || 'en_US', components: input.components || [], recipients, status: 'draft', total: recipients.length, sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, created_at: isoNow() };
  campaignStore.campaigns.unshift(campaign);
  await saveCampaignStore();
  if (input.launch) await launchCampaign(campaign.campaign_id);
  return campaignSummary(campaign);
}
async function launchCampaign(campaignId) {
  await loadCampaignStore();
  const campaign = campaignStore.campaigns.find(item => item.campaign_id === campaignId);
  if (!campaign) throw new Error('Campaign not found');
  campaign.status = 'sending'; campaign.started_at = isoNow(); await saveCampaignStore();
  for (const phone of campaign.recipients) {
    try {
      const result = await sendTemplate(phone, campaign.template_name, campaign.language, campaign.components);
      const wamid = result.messages?.[0]?.id || `local.${randomUUID()}`;
      campaignStore.messages.push({ message_id: randomUUID(), campaign_id: campaignId, phone, wamid, status: 'sent', sent_at: isoNow(), replied: false });
      campaign.sent += 1;
    } catch (error) {
      campaignStore.messages.push({ message_id: randomUUID(), campaign_id: campaignId, phone, status: 'failed', error: error.message, failed_at: isoNow(), replied: false });
      campaign.failed += 1;
    }
    await saveCampaignStore();
  }
  campaign.status = 'completed'; campaign.completed_at = isoNow(); await saveCampaignStore();
  return campaignSummary(campaign);
}
const statusRank = { sent: 1, delivered: 2, read: 3, failed: 0 };
async function handleStatusUpdate(status) {
  await loadCampaignStore();
  const message = campaignStore.messages.find(item => item.wamid === status.id);
  if (!message) return;
  const next = status.status;
  if (next !== 'failed' && statusRank[next] < (statusRank[message.status] || 0)) return;
  message.status = next;
  message[`${next}_at`] = isoNow();
  if (next === 'failed') message.error = status.errors?.[0]?.title || status.errors?.[0]?.message || 'Delivery failed';
  const campaign = campaignStore.campaigns.find(item => item.campaign_id === message.campaign_id);
  if (campaign) {
    const messages = campaignStore.messages.filter(item => item.campaign_id === campaign.campaign_id);
    campaign.sent = messages.filter(item => ['sent', 'delivered', 'read'].includes(item.status)).length;
    campaign.delivered = messages.filter(item => ['delivered', 'read'].includes(item.status)).length;
    campaign.read = messages.filter(item => item.status === 'read').length;
    campaign.failed = messages.filter(item => item.status === 'failed').length;
  }
  await saveCampaignStore();
}
async function markCampaignReply(phone, message) {
  await loadCampaignStore();
  const contextId = message.context?.id;
  const candidate = campaignStore.messages.filter(item => item.phone === normalizePhone(phone) && (contextId ? item.wamid === contextId : true)).sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))[0];
  if (!candidate || candidate.replied) return;
  candidate.replied = true; candidate.last_inbound_at = isoNow();
  const campaign = campaignStore.campaigns.find(item => item.campaign_id === candidate.campaign_id);
  if (campaign) campaign.replied = campaignStore.messages.filter(item => item.campaign_id === campaign.campaign_id && item.replied).length;
  await saveCampaignStore();
}

async function sendWhatsApp(to, message, options = {}) {
  if (dryRun) { console.log(`[dry-run → ${to}] ${message}`); return { dryRun: true }; }
  const response = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: options.type || 'text', ...(options.payload || { text: { body: message } }) })
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || 'WhatsApp send failed');
  return value;
}
const sendOptions = (to, text, options) => sendWhatsApp(to, text, options);
const buttons = (to, text, items) => sendOptions(to, text, { type: 'interactive', payload: { interactive: { type: 'button', body: { text }, action: { buttons: items.slice(0, 3).map(item => ({ type: 'reply', reply: { id: item.id, title: item.title } })) } } } });
const list = (to, text, items) => sendOptions(to, text, { type: 'interactive', payload: { interactive: { type: 'list', body: { text }, action: { button: 'Choose', sections: [{ rows: items.slice(0, 10).map(item => ({ id: item.id, title: item.title, description: item.description || '' })) }] } } } });

async function promptMenu(session) {
  const to = session.phone;
  if (!session.lang) return sendWhatsApp(to, `${languageText.en.welcome}\n\n${languageText.en.language}`);
  if (!session.role) {
    const labels = session.lang === 'mr'
      ? ['कामगार शोधत आहे', 'काम शोधत आहे']
      : session.lang === 'hi'
        ? ['कामगार ढूंढ रहा हूं', 'काम ढूंढ रहा हूं']
        : ['Looking for workers', 'Looking for work'];
    const prompt = session.lang === 'mr' ? 'तुम्ही काय शोधत आहात?' : session.lang === 'hi' ? 'आप क्या ढूंढ रहे हैं?' : t(session, 'role');
    return buttons(to, prompt, [{ id: 'farmer', title: labels[0] }, { id: 'worker', title: labels[1] }]);
  }
  if (session.role === 'farmer') return buttons(to, t(session, 'farmerMenu'), [{ id: 'post', title: t(session, 'post') }, { id: 'browse_workers', title: t(session, 'browseWorkers') }, { id: 'reset', title: t(session, 'reset') }]);
  return buttons(to, t(session, 'workerMenu'), [{ id: 'availability', title: t(session, 'availability') }, { id: 'browse_jobs', title: t(session, 'browseJobs') }, { id: 'reset', title: t(session, 'reset') }]);
}
function valueFromMessage(message) { return message?.interactive?.button_reply?.id || message?.interactive?.list_reply?.id || message?.text?.body?.trim() || ''; }

export async function handleMessage(phone, message) {
  if (!message || processedMessageIds.has(message.id)) return;
  if (message.id) processedMessageIds.add(message.id);
  const session = getSession(phone);
  const input = valueFromMessage(message);
  const choice = normalizeChoice(input);
  if (['menu', 'start', 'hi', 'hello', 'नमस्कार'].includes(choice)) { resetSession(phone); await loadCampaignStore(); const defaultFlow = campaignStore.flows.find(flow => flow.name === 'default_customer_flow'); if (defaultFlow) return startFlow(phone, defaultFlow.flow_id); return promptMenu(getSession(phone)); }
  if (!session.lang) {
    session.lang = choice === '1' || choice.includes('मराठी') ? 'mr' : choice === '2' || choice.includes('हिंदी') ? 'hi' : choice === '3' || choice.includes('english') ? 'en' : null;
    if (!session.lang) return sendWhatsApp(phone, languageText.en.language);
    return promptMenu(session);
  }
  if (!session.role) {
    session.role = choice === 'farmer' || choice === '1' || choice.includes('शेत') || choice.includes('किसान') || choice.includes('कामगार शोध') || choice.includes('मज़दूर ढूंढ') || choice.includes('looking for workers') ? 'farmer' : choice === 'worker' || choice === '2' || choice.includes('कामगार') || choice.includes('मज़दूर') || choice.includes('काम शोध') || choice.includes('काम ढूंढ') || choice.includes('looking for work') ? 'worker' : null;
    if (!session.role) return sendWhatsApp(phone, t(session, 'invalid'));
    setStep(session, 'menu');
    return promptMenu(session);
  }
  if (session.step === 'menu') {
    if (choice === 'reset') { resetSession(phone); return promptMenu(getSession(phone)); }
    if (session.role === 'farmer' && (choice === 'post' || choice === '1')) { setStep(session, 'farmer_name'); return sendWhatsApp(phone, t(session, 'askName')); }
    if (session.role === 'worker' && (choice === 'availability' || choice === '1')) { setStep(session, 'worker_name'); return sendWhatsApp(phone, t(session, 'askName')); }
    if ((session.role === 'farmer' && (choice === 'browse_workers' || choice === '2')) || (session.role === 'worker' && (choice === 'browse_jobs' || choice === '2'))) {
      try { const matches = await findMatches(session); return sendWhatsApp(phone, matches.length ? matches.join('\n\n') : t(session, 'noMatches')); } catch (error) { return sendWhatsApp(phone, `Could not load live matches right now: ${error.message}`); }
    }
    return promptMenu(session);
  }
  const d = session.draft;
  const next = async (field, value, nextStep, promptKey) => { d[field] = value; setStep(session, nextStep); return sendWhatsApp(phone, t(session, promptKey)); };
  if (session.step === 'farmer_name') return next('name', input, 'farmer_taluka', 'askTaluka');
  if (session.step === 'farmer_taluka') return next('taluka', input, 'farmer_village', 'askVillage');
  if (session.step === 'farmer_village') return next('village', input, 'farmer_activities', 'askActivities');
  if (session.step === 'farmer_activities') { const indexes = parseIndexes(input, skills.length + 1); if (!indexes.length) return sendWhatsApp(phone, t(session, 'askActivities')); d.activities = indexes.map(index => index === skills.length ? 'Other work' : skills[index]); if (indexes.includes(skills.length)) { setStep(session, 'farmer_other'); return sendWhatsApp(phone, t(session, 'askOther')); } setStep(session, 'farmer_date'); return sendWhatsApp(phone, t(session, 'askDate')); }
  if (session.step === 'farmer_other') return next('other_work', input, 'farmer_date', 'askDate').then(() => { d.activities = [input]; });
  if (session.step === 'farmer_date') return next('date', input, 'farmer_count', 'askCount');
  if (session.step === 'farmer_count') return next('count', numeric(input), 'farmer_wage', 'askWage');
  if (session.step === 'farmer_wage') return next('wage', numeric(input), 'farmer_unit', 'askUnit');
  if (session.step === 'farmer_unit') { d.payment_unit = units[Math.max(0, Math.min(3, numeric(input) - 1))] || 'daily'; setStep(session, 'farmer_confirm'); return sendWhatsApp(phone, t(session, 'confirm').replace('{summary}', summary(session))); }
  if (session.step === 'worker_name') return next('name', input, 'worker_taluka', 'askTaluka');
  if (session.step === 'worker_taluka') return next('taluka', input, 'worker_village', 'askVillage');
  if (session.step === 'worker_village') return next('village', input, 'worker_type', 'askType');
  if (session.step === 'worker_type') { d.type = choice === '2' || choice === 'team' ? 'team' : 'individual'; if (d.type === 'team') { setStep(session, 'worker_team_size'); return sendWhatsApp(phone, t(session, 'askTeamSize')); } setStep(session, 'worker_skills'); return sendWhatsApp(phone, t(session, 'askSkills')); }
  if (session.step === 'worker_team_size') return next('team_size', numeric(input), 'worker_skills', 'askSkills');
  if (session.step === 'worker_skills') { const selected = selectedSkills(input); if (!selected.length) return sendWhatsApp(phone, t(session, 'askSkills')); d.skills = selected; if (selected.includes('Other')) { setStep(session, 'worker_other'); return sendWhatsApp(phone, t(session, 'askOther')); } setStep(session, 'worker_wage'); return sendWhatsApp(phone, t(session, 'askExpected')); }
  if (session.step === 'worker_other') { d.skills = [input]; setStep(session, 'worker_wage'); return sendWhatsApp(phone, t(session, 'askExpected')); }
  if (session.step === 'worker_wage') return next('wage', numeric(input), 'worker_unit', 'askUnit');
  if (session.step === 'worker_unit') { d.payment_unit = units[Math.max(0, Math.min(3, numeric(input) - 1))] || 'daily'; setStep(session, 'worker_availability'); return sendWhatsApp(phone, t(session, 'askAvailability')); }
  if (session.step === 'worker_availability') { const map = { '1': 'now', now: 'now', '2': 'week', week: 'week', '3': 'later', later: 'later' }; d.availability = map[choice] || 'now'; if (d.availability === 'later') { setStep(session, 'worker_available_date'); return sendWhatsApp(phone, t(session, 'askAvailableDate')); } setStep(session, 'worker_confirm'); return sendWhatsApp(phone, t(session, 'confirm').replace('{summary}', summary(session))); }
  if (session.step === 'worker_available_date') return next('available_from', input, 'worker_confirm', 'confirm').then(() => sendWhatsApp(phone, t(session, 'confirm').replace('{summary}', summary(session))));
  if (session.step === 'farmer_confirm' || session.step === 'worker_confirm') {
    if (!['1', 'confirm', 'yes', 'हो', 'हाँ', 'निश्चित'].some(value => choice.includes(value))) { resetSession(phone); return promptMenu(getSession(phone)); }
    try { await saveProfile(session); const confirmation = session.role === 'farmer' ? t(session, 'posted') : t(session, 'saved'); await sendWhatsApp(phone, `${confirmation}\n\n${t(session, 'private')}`); const matches = await findMatches(session); setStep(session, 'menu'); await sendWhatsApp(phone, matches.length ? `${session.role === 'farmer' ? t(session, 'matchesWorkers') : t(session, 'matchesJobs')}\n\n${matches.join('\n\n')}` : t(session, 'noMatches')); return promptMenu(session); } catch (error) { return sendWhatsApp(phone, `Could not save this yet: ${error.message}`); }
  }
  if (choice.startsWith('bid ')) { setStep(session, 'offer_wage'); d.target_id = input.slice(4).trim(); return sendWhatsApp(phone, t(session, 'offerWage')); }
  if (session.step === 'offer_wage') { d.offer = numeric(input); setStep(session, 'menu'); try { await backend('/offers/', { method: 'POST', body: JSON.stringify({ from_phone: session.phone, target_id: d.target_id, amount: d.offer, unit: d.payment_unit || 'daily' }) }); return sendWhatsApp(phone, t(session, 'offerSent')); } catch { return sendWhatsApp(phone, t(session, 'pending')); } }
  return sendWhatsApp(phone, t(session, 'help'));
}

export function validSignature(request, raw) {
  if (!appSecret) return true;
  const provided = request.headers['x-hub-signature-256'];
  if (!provided) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
  return provided.length === expected.length && timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
export function extractMessages(payload) {
  return (payload.entry || []).flatMap(entry => (entry.changes || []).flatMap(change => (change.value?.messages || []).map(message => ({ phone: message.from, message }))));
}
export function extractEvents(payload) {
  return (payload.entry || []).flatMap(entry => (entry.changes || []).flatMap(change => {
    const value = change.value || {};
    return [
      ...(value.messages || []).map(message => ({ kind: 'message', phone: message.from, message })),
      ...(value.statuses || []).map(status => ({ kind: 'status', status }))
    ];
  }));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === 'GET' && url.pathname === '/whatsapp/webhook') {
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === verifyToken;
      response.writeHead(ok ? 200 : 403, { 'content-type': 'text/plain' }); response.end(ok ? url.searchParams.get('hub.challenge') : 'Forbidden'); return;
    }
    if (request.method === 'POST' && url.pathname === '/whatsapp/webhook') {
      const raw = await body(request); if (!validSignature(request, raw)) { response.writeHead(401); response.end('Invalid signature'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}');
      const payload = JSON.parse(raw);
      for (const item of extractEvents(payload)) {
        if (item.kind === 'status') handleStatusUpdate(item.status).catch(error => console.error('status update error', error));
        else markCampaignReply(item.phone, item.message).then(async () => { if (!(await routeFlowButton(item.phone, item.message))) await handleMessage(item.phone, item.message); }).catch(error => console.error('bot message error', error));
      }
      return;
    }
    if (request.method === 'GET' && (url.pathname === '/whatsapp/ops' || url.pathname === '/whatsapp/ops/')) { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(operationsHtmlV2()); return; }
    if (request.method === 'GET' && url.pathname === '/whatsapp/ops/builder') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(builderHtmlFixed()); return; }
    if (url.pathname.startsWith('/whatsapp/ops')) {
      if (request.method === 'GET' && url.pathname === '/whatsapp/ops/templates') { const value = await listTemplates(); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return; }
      if (request.method === 'POST' && url.pathname === '/whatsapp/ops/templates') { const value = await createTemplate(JSON.parse(await body(request))); response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return; }
      if (request.method === 'POST' && url.pathname === '/whatsapp/ops/flows') { const value = await saveFlow(JSON.parse(await body(request))); response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return; }
      if (request.method === 'GET' && url.pathname === '/whatsapp/ops/flows') { await loadCampaignStore(); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ flows: campaignStore.flows })); return; }
      const startFlowMatch = url.pathname.match(/^\/whatsapp\/ops\/flows\/([^/]+)\/start$/);
      if (request.method === 'POST' && startFlowMatch) { const value = JSON.parse(await body(request)); const result = await startFlow(value.phone, decodeURIComponent(startFlowMatch[1])); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result)); return; }
      if (request.method === 'POST' && url.pathname === '/whatsapp/ops/campaigns') { const value = await createCampaign(JSON.parse(await body(request))); response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return; }
      if (request.method === 'GET' && url.pathname === '/whatsapp/ops/campaigns') { await loadCampaignStore(); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ campaigns: campaignStore.campaigns.map(campaignSummary) })); return; }
      const adminCampaign = url.pathname.match(/^\/whatsapp\/ops\/campaigns\/([^/]+)(?:\/(send|analytics))?$/);
      if (adminCampaign) {
        await loadCampaignStore(); const campaign = campaignStore.campaigns.find(item => item.campaign_id === adminCampaign[1]);
        if (!campaign) { response.writeHead(404); response.end('Campaign not found'); return; }
        if (request.method === 'POST' && adminCampaign[2] === 'send') { const value = await launchCampaign(campaign.campaign_id); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return; }
        if (request.method === 'GET' && (!adminCampaign[2] || adminCampaign[2] === 'analytics')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(campaignSummary(campaign))); return; }
      }
      response.writeHead(404); response.end('Not found'); return;
    }
    if (request.method === 'POST' && url.pathname === '/whatsapp/campaigns') { response.writeHead(404); response.end('Not found'); return; }
    if (request.method === 'GET' && url.pathname === '/whatsapp/campaigns') { response.writeHead(404); response.end('Not found'); return; }
    const campaignMatch = url.pathname.match(/^\/whatsapp\/campaigns\/([^/]+)(?:\/(send|analytics))?$/);
    if (campaignMatch) {
      if (!url.pathname.startsWith('/whatsapp/ops/')) { response.writeHead(404); response.end('Not found'); return; }
      const campaignId = campaignMatch[1]; await loadCampaignStore();
      const campaign = campaignStore.campaigns.find(item => item.campaign_id === campaignId); if (!campaign) { response.writeHead(404); response.end('Campaign not found'); return; }
      if (request.method === 'POST' && campaignMatch[2] === 'send') { const value = await launchCampaign(campaignId); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return; }
      if (request.method === 'GET' && (!campaignMatch[2] || campaignMatch[2] === 'analytics')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(campaignSummary(campaign))); return; }
    }
    if (request.method === 'POST' && url.pathname === '/whatsapp/test') {
      const value = JSON.parse(await body(request)); await handleMessage(value.phone || '919999999999', { id: `test-${Date.now()}`, text: { body: value.text || 'Hi' } }); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, dryRun })); return;
    }
    if (request.method === 'GET' && url.pathname === '/whatsapp/health') { await loadCampaignStore(); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, dryRun, backendUrl, sessions: sessions.size, campaigns: campaignStore.campaigns.length, campaignMessages: campaignStore.messages.length })); return; }
    response.writeHead(404); response.end('Not found');
  } catch (error) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
});
if (process.env.VERCEL !== '1') {
  server.listen(port, () => console.log(`KaamSetu WhatsApp bot: http://localhost:${port} (${dryRun ? 'dry-run' : 'live'})`));
}

