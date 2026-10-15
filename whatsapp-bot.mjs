import { createHmac, timingSafeEqual } from 'node:crypto';
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
const dryRun = process.env.BOT_DRY_RUN === 'true' || !phoneNumberId || !accessToken;

const sessions = new Map();
const processedMessageIds = new Set();
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
  if (['menu', 'start', 'hi', 'hello', 'नमस्कार'].includes(choice)) { resetSession(phone); return promptMenu(getSession(phone)); }
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
      const payload = JSON.parse(raw); for (const item of extractMessages(payload)) handleMessage(item.phone, item.message).catch(error => console.error('bot message error', error)); return;
    }
    if (request.method === 'POST' && url.pathname === '/whatsapp/test') {
      const value = JSON.parse(await body(request)); await handleMessage(value.phone || '919999999999', { id: `test-${Date.now()}`, text: { body: value.text || 'Hi' } }); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, dryRun })); return;
    }
    if (request.method === 'GET' && url.pathname === '/whatsapp/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, dryRun, backendUrl, sessions: sessions.size })); return; }
    response.writeHead(404); response.end('Not found');
  } catch (error) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
});
if (process.env.VERCEL !== '1') {
  server.listen(port, () => console.log(`KaamSetu WhatsApp bot: http://localhost:${port} (${dryRun ? 'dry-run' : 'live'})`));
}

