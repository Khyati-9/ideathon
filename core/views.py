import json
import logging
import urllib.error
import urllib.request
from datetime import date
from decimal import Decimal, InvalidOperation

from django.conf import settings
from django.db import transaction
from django.db.models import Case, Count, IntegerField, Q, Value, When
from django.http import Http404, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST
from django.db.models import Case, Count, F, IntegerField, Q, Value, When
from .models import FarmerProfile, JobRequirement, LabourProfile, Offer, Skill, User

logger = logging.getLogger(__name__)


# ---------- lenient helpers: bad or missing values become blank, never errors ----------

def _body(request):
    try:
        data = json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _text(data, key, limit=100):
    return str(data.get(key) or "").strip()[:limit]


def _phone(value):
    """Last 10 digits, or '' if there is no usable number."""
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    return digits[-10:] if len(digits) >= 10 else ""


def _as_list(value):
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return []


def _decimal(value, limit):
    """Number below `limit`, else None."""
    try:
        number = Decimal(str(value))
    except (InvalidOperation, TypeError):
        return None
    return number if 0 <= number < limit else None


def _int(value, limit=1_000_000):
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return None
    return number if 0 <= number < limit else None


def _date(value):
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _skills_from(data, key):
    names = _as_list(data.get(key))
    return list(Skill.objects.filter(name_en__in=names, is_active=True))


def _get_or_create_user(data, role, phone):
    """Phone is the identity. Same phone = same account."""
    name = _text(data, "name", 150)
    alt = _phone(data.get("alternatePhone"))
    user, created = User.objects.get_or_create(
        phone=phone,
        defaults={
            "username": phone,
            "first_name": name,
            "alternate_phone": alt,
            "role": role,
        },
    )
    if created:
        user.set_unusable_password()
        user.save()
    else:
        if name:
            user.first_name = name
        if alt:
            user.alternate_phone = alt
        user.save(update_fields=["first_name", "alternate_phone", "updated_at"])
    return user


def _phone_error():
    return JsonResponse(
        {"errors": {"phone": "Please enter your 10 digit mobile number"}}, status=400
    )


# ---------- OTP service (WhatsApp OTP at settings.OTP_BASE_URL) ----------
# Currently unused: neither signup form asks for an OTP. Kept for later use.

OTP_SEND_PATH = "/otp/test/api/send-otp/"
OTP_VERIFY_PATH = "/otp/test/api/verify-otp/"


def _otp_headers():
    """Request headers for the OTP service, including the auth token.
    Token comes from settings (read from .env), never hard-coded here."""
    headers = {"Content-Type": "application/json"}
    token = getattr(settings, "OTP_API_TOKEN", "")
    if token:
        header_name = getattr(settings, "OTP_AUTH_HEADER", "Authorization")
        scheme = getattr(settings, "OTP_AUTH_SCHEME", "Bearer")
        headers[header_name] = f"{scheme} {token}" if scheme else token
    return headers


def _otp_post(path, payload):
    """POST JSON to the OTP service. Returns (status_code, body_dict).
    status_code is None if the service could not be reached."""
    url = settings.OTP_BASE_URL.rstrip("/") + path
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers=_otp_headers(),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode() or "{}")
        except ValueError:
            body = {}
        return exc.code, body
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None, {}


@csrf_exempt
@require_POST
def send_otp(request):
    data = _body(request)
    if data is None:
        logger.info("OTP send: invalid JSON body")
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    phone = _phone(data.get("phone"))
    if not phone:
        logger.info("OTP send: missing or invalid phone number")
        return _phone_error()

    masked = "******" + phone[-4:]

    # the OTP service wants international format: 91XXXXXXXXXX
    status, body = _otp_post(OTP_SEND_PATH, {"phone_number": "91" + phone})
    if status == 200:
        logger.info("OTP send: sent to phone %s", masked)
        return JsonResponse({"ok": True, "message": "OTP sent"})
    if status is None:
        logger.error("OTP send: OTP service not reachable for phone %s", masked)
        return JsonResponse({"error": "OTP service is not reachable"}, status=502)
    logger.error(
        "OTP send: service refused for phone %s, status=%s body=%s",
        masked, status, body,
    )
    return JsonResponse(
        {"error": body.get("error") or "Could not send OTP"}, status=502
    )


def _check_otp(data, phone):
    """Returns None if the OTP is valid, otherwise the error response to return.
    Removes 'otp' from data so the code is never saved in raw_form."""
    masked = "******" + phone[-4:]
    code = str(data.pop("otp", "") or "").strip()[:10]
    if not code:
        logger.info("OTP check: no otp in request for phone %s", masked)
        return JsonResponse(
            {"errors": {"otp": "Please enter the OTP sent to your WhatsApp"}},
            status=400,
        )

    status, body = _otp_post(
        OTP_VERIFY_PATH, {"phone_number": "91" + phone, "otp": code}
    )
    if status == 200 and body.get("success") is True:
        logger.info("OTP check: verified for phone %s", masked)
        return None
    if status is None:
        logger.error("OTP check: OTP service not reachable for phone %s", masked)
        return JsonResponse({"error": "OTP service is not reachable"}, status=502)
    if status == 400:
        logger.info(
            "OTP check: rejected for phone %s, service said: %s",
            masked, body.get("error"),
        )
        return JsonResponse(
            {"errors": {"otp": body.get("error") or "Invalid OTP"}}, status=400
        )
    logger.error(
        "OTP check: unexpected response for phone %s, status=%s body=%s",
        masked, status, body,
    )
    return JsonResponse({"error": "Could not verify OTP"}, status=502)


# ---------- farmer form (no OTP) ----------

@csrf_exempt
@require_POST
def farmer_signup(request):
    data = _body(request)
    if data is None:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    phone = _phone(data.get("phone"))
    if not phone:
        return _phone_error()

    # farmer form has no OTP step; keep any stray code out of raw_form
    data.pop("otp", None)

    taluka = _text(data, "taluka")
    village = _text(data, "village")
    district = _text(data, "district")

    with transaction.atomic():
        user = _get_or_create_user(data, User.Role.FARMER, phone)
        farmer, _ = FarmerProfile.objects.update_or_create(
            user=user,
            defaults={
                "district": district,
                "taluka": taluka,
                "village": village,
                "meta": {"raw_form": data},
            },
        )
        job = JobRequirement.objects.create(
            farmer=farmer,
            district=district,
            taluka=taluka,
            village=village,
            category=_text(data, "category", 50),
            job_type=_text(data, "jobType"),
            work_date=_date(data.get("date")),
            workers_needed=_int(data.get("count")),
            farm_size=_decimal(data.get("farmSize"), 10_000),
            wage_offered=_decimal(data.get("wageOffer"), 1_000_000),
            payment_method=_text(data, "payMethod", 50),
            contact_preference=_text(data, "contactPreference", 30),
            meta={"raw_form": data, "activities_raw": _as_list(data.get("activities"))},
        )
        job.skills.set(_skills_from(data, "activities"))

    return JsonResponse(
        {"ok": True, "user_id": user.id, "farmer_id": farmer.id, "job_id": job.id},
        status=201,
    )


# ---------- labour form (individual or team, no OTP) ----------

@csrf_exempt
@require_POST
def labour_signup(request):
    data = _body(request)
    if data is None:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    phone = _phone(data.get("phone"))
    if not phone:
        return _phone_error()

    # labour form has no OTP step; keep any stray code out of raw_form
    data.pop("otp", None)

    profile_type = _text(data, "type", 10)
    if profile_type not in LabourProfile.Type.values:
        profile_type = LabourProfile.Type.INDIVIDUAL

    availability = _text(data, "availability", 10)
    if availability not in LabourProfile.Availability.values:
        availability = LabourProfile.Availability.NOW

    team_size = _int(data.get("teamSize"), 100_000) or 1
    worked_days = _int(data.get("workedDays"), 32_000)
    travel_km = _int(data.get("travelKm"), 10_000) or 10

    with transaction.atomic():
        user = _get_or_create_user(data, User.Role.LABOURER, phone)
        profile, _ = LabourProfile.objects.update_or_create(
            user=user,
            defaults={
                "district": _text(data, "district"),
                "taluka": _text(data, "taluka"),
                "village": _text(data, "village"),
                "type": profile_type,
                "team_name": _text(data, "teamName"),
                "team_size": team_size,
                "preferred_work": _text(data, "preferredWork"),
                "expected_wage": _decimal(data.get("wageAsk"), 1_000_000),
                "worked_days": worked_days,
                "travel_km": travel_km,
                "availability": availability,
                "available_from": _date(data.get("availableFrom")),
                "available_to": _date(data.get("availableTo")),
                "last_work_source": _text(data, "lastWorkSource", 50),
                "contact_preference": _text(data, "contactPreference", 30),
                "meta": {"raw_form": data, "skills_raw": _as_list(data.get("skills"))},
            },
        )
        profile.skills.set(_skills_from(data, "skills"))

    return JsonResponse(
        {"ok": True, "user_id": user.id, "labour_id": profile.id}, status=201
    )


@require_GET
def demo_farmers(request):
    """Demo only: lists dummy farmers so the frontend can 'log in' as one.
    GET /api/demo/farmers/?q=niphad&limit=20"""
    if not settings.DEMO_MODE:
        raise Http404

    q = request.GET.get("q", "").strip()
    limit = _int(request.GET.get("limit"), 200) or 20

    farmers = (
        FarmerProfile.objects.filter(user__username__startswith="dummy_")
        .select_related("user")
        .annotate(jobs_count=Count("jobs"))
        .order_by("-jobs_count", "id")
    )
    if q:
        farmers = farmers.filter(
            Q(user__first_name__icontains=q)
            | Q(user__phone__icontains=q)
            | Q(taluka__icontains=q)
            | Q(village__icontains=q)
        )

    return JsonResponse({"farmers": [
        {
            "farmer_id": f.id,
            "name": f.user.first_name,
            "phone": f.user.phone,
            "village": f.village,
            "taluka": f.taluka,
            "jobs_count": f.jobs_count,
        }
        for f in farmers[:limit]
    ]})


@require_GET
def farmer_profile(request):
    """Farmer's profile: his details and his jobs (no labour in here).
    GET /api/farmer/profile/?farmer_id=12
    GET /api/farmer/profile/?phone=1234567890   (still works)"""
    farmer_id = _int(request.GET.get("farmer_id"))
    phone = _phone(request.GET.get("phone"))
    if not farmer_id and not phone:
        return JsonResponse({"error": "Send farmer_id or phone"}, status=400)

    lookup = {"id": farmer_id} if farmer_id else {"user__phone": phone}
    try:
        farmer = FarmerProfile.objects.select_related("user").get(**lookup)
    except FarmerProfile.DoesNotExist:
        return JsonResponse({"error": "No farmer profile found"}, status=404)

    jobs = farmer.jobs.prefetch_related("skills").order_by("-created_at")

    return JsonResponse({
        "farmer": {
            "farmer_id": farmer.id,
            "name": farmer.user.first_name,
            "phone": farmer.user.phone,
            "alternate_phone": farmer.user.alternate_phone,
            "district": farmer.district,
            "taluka": farmer.taluka,
            "village": farmer.village,
        },
        "jobs": [
            {
                "job_id": j.id,
                "job_type": j.job_type,
                "category": j.category,
                "skills": [s.name_en for s in j.skills.all()],
                "work_date": j.work_date,
                "workers_needed": j.workers_needed,
                "wage_offered": j.wage_offered,
                "village": j.village,
                "taluka": j.taluka,
                "status": j.status,
                "created_at": j.created_at,
            }
            for j in jobs
        ],
    })


@require_GET
def labour_jobs(request, labour_id):
    """Open upcoming jobs that match this labourer's skills and village.
    GET /api/labour/<labour_id>/jobs/
        ?taluka=Niphad &date_from=2026-10-20 &date_to=2026-10-30
        &min_wage=600 &limit=20 &offset=0"""
    try:
        p = LabourProfile.objects.prefetch_related("skills").get(id=labour_id)
    except LabourProfile.DoesNotExist:
        return JsonResponse({"error": "Labour profile not found"}, status=404)

    skill_ids = [s.id for s in p.skills.all()]
    today = date.today()

    jobs = (
        JobRequirement.objects.filter(status=JobRequirement.Status.OPEN)
        .filter(Q(work_date__gte=today) | Q(work_date__isnull=True))
        .select_related("farmer", "farmer__user")
        .prefetch_related("skills")
    )

    if skill_ids:
        jobs = jobs.annotate(
            skill_match=Count("skills", filter=Q(skills__id__in=skill_ids), distinct=True)
        ).filter(skill_match__gt=0)
    elif p.preferred_work:
        # no linked skills: fall back to the work they typed
        jobs = jobs.filter(job_type__icontains=p.preferred_work).annotate(
            skill_match=Value(0, output_field=IntegerField())
        )
    else:
        jobs = jobs.none()

    # match on village: only jobs in the labourer's village (if they have one)
    if p.village:
        jobs = jobs.filter(village__iexact=p.village)

    # filters from the screen
    taluka = request.GET.get("taluka", "").strip()
    if taluka:
        jobs = jobs.filter(taluka__iexact=taluka)

    date_from = _date(request.GET.get("date_from"))
    if date_from:
        jobs = jobs.filter(work_date__gte=date_from)
    date_to = _date(request.GET.get("date_to"))
    if date_to:
        jobs = jobs.filter(work_date__lte=date_to)

    min_wage = _decimal(request.GET.get("min_wage"), 1_000_000)
    if min_wage is not None:
        jobs = jobs.filter(wage_offered__gte=min_wage)

    jobs = jobs.order_by("-skill_match", "work_date", "id")

    total = jobs.count()
    limit = _int(request.GET.get("limit"), 200) or 20
    offset = _int(request.GET.get("offset"), 1_000_000) or 0
    page = list(jobs[offset:offset + limit])

    offer_status = dict(
        Offer.objects.filter(labour=p, job_id__in=[j.id for j in page])
        .values_list("job_id", "status")
    )

    return JsonResponse({
        "labour_id": p.id,
        "total": total,
        "limit": limit,
        "offset": offset,
        "jobs": [
            {
                "job_id": j.id,
                "job_type": j.job_type,
                "category": j.category,
                "skills": [s.name_en for s in j.skills.all()],
                "matched_skills": j.skill_match,
                "work_date": j.work_date,
                "workers_needed": j.workers_needed,
                "wage_offered": j.wage_offered,
                "payment_method": j.payment_method,
                "village": j.village,
                "taluka": j.taluka,
                "farmer_name": j.farmer.user.first_name,
                "offer_status": offer_status.get(j.id, "none"),
            }
            for j in page
        ],
    })


@require_GET
def job_matches(request, job_id):
    """Labour profiles (individuals and mukkadams/teams) matching one job's
    skills and village.
    GET /api/farmer/jobs/<job_id>/matches/
        ?type=team|individual &taluka=Niphad &max_wage=700 &limit=20 &offset=0"""
    try:
        job = JobRequirement.objects.prefetch_related("skills").get(id=job_id)
    except JobRequirement.DoesNotExist:
        return JsonResponse({"error": "Job not found"}, status=404)

    skill_ids = [s.id for s in job.skills.all()]

    labour = (
        LabourProfile.objects.filter(is_available=True)
        .select_related("user")
        .prefetch_related("skills")
    )

    if skill_ids:
        labour = labour.annotate(
            skill_match=Count(
                "skills", filter=Q(skills__id__in=skill_ids), distinct=True
            )
        ).filter(skill_match__gt=0)
    elif job.job_type:
        # job has no linked skills: fall back to the work they typed
        labour = labour.filter(preferred_work__icontains=job.job_type).annotate(
            skill_match=Value(0, output_field=IntegerField())
        )
    else:
        labour = labour.none()

    # match on village: only labour from the job's village (if the job has one)
    if job.village:
        labour = labour.filter(village__iexact=job.village)

    # optional filters from the screen
    profile_type = request.GET.get("type", "")
    if profile_type in LabourProfile.Type.values:
        labour = labour.filter(type=profile_type)

    taluka = request.GET.get("taluka", "").strip()
    if taluka:
        labour = labour.filter(taluka__iexact=taluka)

    max_wage = _decimal(request.GET.get("max_wage"), 1_000_000)
    if max_wage is not None:
        labour = labour.filter(expected_wage__lte=max_wage)

    labour = labour.order_by("-skill_match", "id")

    total = labour.count()
    limit = _int(request.GET.get("limit"), 200) or 20
    offset = _int(request.GET.get("offset"), 1_000_000) or 0

    return JsonResponse({
        "job": {
            "job_id": job.id,
            "job_type": job.job_type,
            "skills": [s.name_en for s in job.skills.all()],
            "work_date": job.work_date,
            "workers_needed": job.workers_needed,
            "wage_offered": job.wage_offered,
            "village": job.village,
            "taluka": job.taluka,
        },
        "total": total,
        "limit": limit,
        "offset": offset,
        "matches": [
            {
                "labour_id": p.id,
                "name": p.team_name or p.user.first_name or p.user.phone,
                "type": p.type,
                "team_size": p.team_size,
                "phone": p.user.phone,
                "alternate_phone": p.user.alternate_phone,
                "village": p.village,
                "taluka": p.taluka,
                "skills": [s.name_en for s in p.skills.all()],
                "matched_skills": p.skill_match,
                "expected_wage": p.expected_wage,
                "availability": p.availability,
                "travel_km": p.travel_km,
                "worked_days": p.worked_days,
            }
            for p in labour[offset:offset + limit]
        ],
    })


@require_GET
def demo_labour(request):
    """Demo only: lists dummy labour so the frontend can 'log in' as one.
    GET /api/demo/labour/?q=niphad&type=team&limit=20"""
    if not settings.DEMO_MODE:
        raise Http404

    q = request.GET.get("q", "").strip()
    limit = _int(request.GET.get("limit"), 200) or 20

    labour = (
        LabourProfile.objects.filter(user__username__startswith="dummy_")
        .select_related("user")
        .annotate(
            pending_offers=Count(
                "offers", filter=Q(offers__status=Offer.Status.PENDING), distinct=True
            )
        )
        .order_by("-pending_offers", "id")
    )
    profile_type = request.GET.get("type", "")
    if profile_type in LabourProfile.Type.values:
        labour = labour.filter(type=profile_type)
    if q:
        labour = labour.filter(
            Q(user__first_name__icontains=q)
            | Q(user__phone__icontains=q)
            | Q(team_name__icontains=q)
            | Q(taluka__icontains=q)
            | Q(village__icontains=q)
        )

    return JsonResponse({"labour": [
        {
            "labour_id": p.id,
            "name": p.team_name or p.user.first_name or p.user.phone,
            "type": p.type,
            "team_size": p.team_size,
            "phone": p.user.phone,
            "village": p.village,
            "taluka": p.taluka,
            "pending_offers": p.pending_offers,
        }
        for p in labour[:limit]
    ]})


@require_GET
def labour_profile(request):
    """Labourer's profile: his details and the offers sent to him.
    GET /api/labour/profile/?labour_id=8
    GET /api/labour/profile/?phone=1234567890   (still works)"""
    labour_id = _int(request.GET.get("labour_id"))
    phone = _phone(request.GET.get("phone"))
    if not labour_id and not phone:
        return JsonResponse({"error": "Send labour_id or phone"}, status=400)

    lookup = {"id": labour_id} if labour_id else {"user__phone": phone}
    try:
        p = (
            LabourProfile.objects.select_related("user")
            .prefetch_related("skills")
            .get(**lookup)
        )
    except LabourProfile.DoesNotExist:
        return JsonResponse({"error": "No labour profile found"}, status=404)

    offers = (
        Offer.objects.filter(labour=p)
        .select_related("job", "job__farmer", "job__farmer__user")
        .order_by(
            Case(
                When(status=Offer.Status.PENDING, then=Value(0)),
                default=Value(1),
                output_field=IntegerField(),
            ),
            "-created_at",
        )
    )

    offer_list = []
    for o in offers:
        farmer_user = o.job.farmer.user
        item = {
            "offer_id": o.id,
            "status": o.status,
            "wage": o.wage,
            "headcount": o.headcount,
            "message": o.message,
            "created_at": o.created_at,
            "responded_at": o.responded_at,
            "job": {
                "job_id": o.job.id,
                "job_type": o.job.job_type,
                "work_date": o.job.work_date,
                "village": o.job.village,
                "taluka": o.job.taluka,
                "workers_needed": o.job.workers_needed,
                "wage_offered": o.job.wage_offered,
            },
            "farmer": {
                "name": farmer_user.first_name,
                "village": o.job.farmer.village,
                "taluka": o.job.farmer.taluka,
            },
        }
        # farmer's number is shared only once the offer is accepted
        if o.status == Offer.Status.ACCEPTED:
            item["farmer"]["phone"] = farmer_user.phone
            item["farmer"]["alternate_phone"] = farmer_user.alternate_phone
        offer_list.append(item)

    return JsonResponse({
        "labour": {
            "labour_id": p.id,
            "name": p.team_name or p.user.first_name or p.user.phone,
            "type": p.type,
            "team_name": p.team_name,
            "team_size": p.team_size,
            "phone": p.user.phone,
            "alternate_phone": p.user.alternate_phone,
            "district": p.district,
            "taluka": p.taluka,
            "village": p.village,
            "skills": [s.name_en for s in p.skills.all()],
            "preferred_work": p.preferred_work,
            "expected_wage": p.expected_wage,
            "availability": p.availability,
            "available_from": p.available_from,
            "available_to": p.available_to,
            "is_available": p.is_available,
            "travel_km": p.travel_km,
            "worked_days": p.worked_days,
        },
        "pending_offers": sum(1 for o in offer_list if o["status"] == "pending"),
        "offers": offer_list,
    })


@require_GET
def explore_jobs(request):
    """Browse all open, upcoming jobs. No profile needed.
    GET /api/jobs/explore/
        ?skill=Tomato picking,Weeding &category=Harvesting &q=tomato
        &district=Nashik &taluka=Niphad &village=Pimpalgaon
        &date=2026-10-20 &date_from=2026-10-20 &date_to=2026-10-30
        &min_wage=600 &max_wage=900 &min_workers=5
        &payment_method=Daily wage / per day
        &sort=date|newest|wage_high|wage_low
        &labour_id=8 &limit=20 &offset=0
    skill can be comma separated or repeated. labour_id is optional and only
    adds offer_status per job for that labourer."""
    jobs = (
        JobRequirement.objects.filter(status=JobRequirement.Status.OPEN)
        .filter(Q(work_date__gte=date.today()) | Q(work_date__isnull=True))
        .select_related("farmer", "farmer__user")
        .prefetch_related("skills")
    )

    skills = []
    for raw in request.GET.getlist("skill"):
        skills.extend(_as_list(raw))
    if skills:
        jobs = jobs.filter(skills__name_en__in=skills).distinct()

    for param in ("district", "taluka", "village", "category"):
        value = request.GET.get(param, "").strip()
        if value:
            jobs = jobs.filter(**{f"{param}__iexact": value})

    payment_method = request.GET.get("payment_method", "").strip()
    if payment_method:
        jobs = jobs.filter(payment_method__iexact=payment_method)

    q = request.GET.get("q", "").strip()
    if q:
        jobs = jobs.filter(Q(job_type__icontains=q) | Q(village__icontains=q))

    exact_date = _date(request.GET.get("date"))
    if exact_date:
        jobs = jobs.filter(work_date=exact_date)
    date_from = _date(request.GET.get("date_from"))
    if date_from:
        jobs = jobs.filter(work_date__gte=date_from)
    date_to = _date(request.GET.get("date_to"))
    if date_to:
        jobs = jobs.filter(work_date__lte=date_to)

    min_wage = _decimal(request.GET.get("min_wage"), 1_000_000)
    if min_wage is not None:
        jobs = jobs.filter(wage_offered__gte=min_wage)
    max_wage = _decimal(request.GET.get("max_wage"), 1_000_000)
    if max_wage is not None:
        jobs = jobs.filter(wage_offered__lte=max_wage)

    min_workers = _int(request.GET.get("min_workers"))
    if min_workers:
        jobs = jobs.filter(workers_needed__gte=min_workers)

    sort = request.GET.get("sort", "date")
    if sort == "newest":
        jobs = jobs.order_by("-created_at", "id")
    elif sort == "wage_high":
        jobs = jobs.order_by(F("wage_offered").desc(nulls_last=True), "id")
    elif sort == "wage_low":
        jobs = jobs.order_by(F("wage_offered").asc(nulls_last=True), "id")
    else:
        jobs = jobs.order_by(F("work_date").asc(nulls_last=True), "id")

    total = jobs.count()
    limit = _int(request.GET.get("limit"), 200) or 20
    offset = _int(request.GET.get("offset"), 1_000_000) or 0
    page = list(jobs[offset:offset + limit])

    offer_status = {}
    labour_id = _int(request.GET.get("labour_id"))
    if labour_id:
        offer_status = dict(
            Offer.objects.filter(labour_id=labour_id, job_id__in=[j.id for j in page])
            .values_list("job_id", "status")
        )

    return JsonResponse({
        "total": total,
        "limit": limit,
        "offset": offset,
        "jobs": [
            {
                "job_id": j.id,
                "job_type": j.job_type,
                "farmer_id": j.farmer_id, 
                "category": j.category,
                "skills": [s.name_en for s in j.skills.all()],
                "work_date": j.work_date,
                "workers_needed": j.workers_needed,
                "wage_offered": j.wage_offered,
                "payment_method": j.payment_method,
                "district": j.district,
                "taluka": j.taluka,
                "village": j.village,
                "farmer_name": j.farmer.user.first_name,
                "offer_status": offer_status.get(j.id, "none"),
                "created_at": j.created_at,
            }
            for j in page
        ],
    })


@require_GET
def explore_workers(request):
    """Browse all available workers and teams. No job needed.
    GET /api/workers/explore/
        ?skill=Tomato picking,Spraying &skill_category=Harvesting &q=girnara
        &type=team|individual &district=Nashik &taluka=Niphad &village=Girnara
        &min_wage=500 &max_wage=700 &min_team_size=5
        &availability=now|week|later &date=2026-10-20
        &min_worked_days=10
        &sort=newest|wage_low|wage_high|team_size|experience
        &limit=20 &offset=0
    skill can be comma separated or repeated. date returns workers who are
    free on that day (no date window set counts as free)."""
    workers = (
        LabourProfile.objects.filter(is_available=True)
        .select_related("user")
        .prefetch_related("skills")
    )

    skills = []
    for raw in request.GET.getlist("skill"):
        skills.extend(_as_list(raw))
    if skills:
        workers = workers.filter(skills__name_en__in=skills).distinct()

    skill_category = request.GET.get("skill_category", "").strip()
    if skill_category:
        workers = workers.filter(
            skills__category__name_en__iexact=skill_category
        ).distinct()

    profile_type = request.GET.get("type", "")
    if profile_type in LabourProfile.Type.values:
        workers = workers.filter(type=profile_type)

    for param in ("district", "taluka", "village"):
        value = request.GET.get(param, "").strip()
        if value:
            workers = workers.filter(**{f"{param}__iexact": value})

    availability = request.GET.get("availability", "")
    if availability in LabourProfile.Availability.values:
        workers = workers.filter(availability=availability)

    q = request.GET.get("q", "").strip()
    if q:
        workers = workers.filter(
            Q(team_name__icontains=q)
            | Q(user__first_name__icontains=q)
            | Q(preferred_work__icontains=q)
            | Q(village__icontains=q)
        )

    # free on a given day: no window set, or the day falls inside it
    free_on = _date(request.GET.get("date"))
    if free_on:
        workers = workers.filter(
            Q(available_from__isnull=True) | Q(available_from__lte=free_on),
            Q(available_to__isnull=True) | Q(available_to__gte=free_on),
        )

    min_wage = _decimal(request.GET.get("min_wage"), 1_000_000)
    if min_wage is not None:
        workers = workers.filter(expected_wage__gte=min_wage)
    max_wage = _decimal(request.GET.get("max_wage"), 1_000_000)
    if max_wage is not None:
        workers = workers.filter(expected_wage__lte=max_wage)

    min_team_size = _int(request.GET.get("min_team_size"))
    if min_team_size:
        workers = workers.filter(team_size__gte=min_team_size)

    min_worked_days = _int(request.GET.get("min_worked_days"))
    if min_worked_days:
        workers = workers.filter(worked_days__gte=min_worked_days)

    sort = request.GET.get("sort", "newest")
    if sort == "wage_low":
        workers = workers.order_by(F("expected_wage").asc(nulls_last=True), "id")
    elif sort == "wage_high":
        workers = workers.order_by(F("expected_wage").desc(nulls_last=True), "id")
    elif sort == "team_size":
        workers = workers.order_by("-team_size", "id")
    elif sort == "experience":
        workers = workers.order_by(F("worked_days").desc(nulls_last=True), "id")
    else:
        workers = workers.order_by("-created_at", "id")

    total = workers.count()
    limit = _int(request.GET.get("limit"), 200) or 20
    offset = _int(request.GET.get("offset"), 1_000_000) or 0

    return JsonResponse({
        "total": total,
        "limit": limit,
        "offset": offset,
        "workers": [
            {
                "labour_id": p.id,
                "name": p.team_name or p.user.first_name or "Worker",
                "type": p.type,
                "team_size": p.team_size,
                "district": p.district,
                "taluka": p.taluka,
                "village": p.village,
                "skills": [s.name_en for s in p.skills.all()],
                "preferred_work": p.preferred_work,
                "expected_wage": p.expected_wage,
                "worked_days": p.worked_days,
                "travel_km": p.travel_km,
                "availability": p.availability,
                "available_from": p.available_from,
                "available_to": p.available_to,
            }
            for p in workers[offset:offset + limit]
        ],
    })


# ---------- WhatsApp / lightweight offer flow ----------

@csrf_exempt
@require_POST
def create_offer(request):
    """Create a pending farmer-to-worker offer or worker-to-job bid.

    The prototype bot sends ``from_phone``, ``target_id`` and ``amount``.
    A farmer's target is a labour id and the newest open job is used; a
    worker's target is a job id and the worker is resolved from the phone.
    Phone numbers are used only for identity and are never returned here.
    """
    data = _body(request)
    if data is None:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    phone = _phone(data.get("from_phone") or data.get("phone"))
    amount = _decimal(data.get("amount") or data.get("wage"), 1_000_000)
    target_id = _int(data.get("target_id"), 1_000_000)
    if not phone or amount is None or not target_id:
        return JsonResponse({"error": "from_phone, target_id and positive amount are required"}, status=422)

    try:
        user = User.objects.get(phone=phone)
    except User.DoesNotExist:
        return JsonResponse({"error": "Profile not found for this phone"}, status=404)

    try:
        if user.role == User.Role.FARMER:
            farmer = user.farmer_profile
            job = farmer.jobs.filter(status=JobRequirement.Status.OPEN).order_by("-created_at").first()
            labour = LabourProfile.objects.get(id=target_id, is_available=True)
        else:
            labour = user.labour_profile
            job = JobRequirement.objects.get(id=target_id, status=JobRequirement.Status.OPEN)
    except (FarmerProfile.DoesNotExist, LabourProfile.DoesNotExist, JobRequirement.DoesNotExist):
        return JsonResponse({"error": "Target profile or open job not found"}, status=404)
    if not job:
        return JsonResponse({"error": "No open job found for this farmer"}, status=404)

    offer, created = Offer.objects.update_or_create(
        job=job, labour=labour,
        defaults={"wage": amount, "headcount": labour.team_size or 1, "status": Offer.Status.PENDING, "message": _text(data, "message", 300)},
    )
    return JsonResponse({"ok": True, "created": created, "offer": {"offer_id": offer.id, "job_id": job.id, "labour_id": labour.id, "wage": offer.wage, "status": offer.status}}, status=201 if created else 200)


@csrf_exempt
@require_POST
def respond_offer(request, offer_id):
    data = _body(request)
    if data is None:
        return JsonResponse({"error": "Invalid JSON"}, status=400)
    status = _text(data, "status", 20).lower()
    if status not in {Offer.Status.ACCEPTED, Offer.Status.REJECTED, Offer.Status.WITHDRAWN}:
        return JsonResponse({"error": "status must be accepted, rejected, or withdrawn"}, status=422)
    try:
        offer = Offer.objects.get(id=offer_id)
    except Offer.DoesNotExist:
        return JsonResponse({"error": "Offer not found"}, status=404)
    offer.status = status
    offer.responded_at = timezone.now()
    offer.save(update_fields=["status", "responded_at", "updated_at"])
    if status == Offer.Status.ACCEPTED:
        offer.job.status = JobRequirement.Status.FILLED
        offer.job.save(update_fields=["status", "updated_at"])
    return JsonResponse({"ok": True, "offer": {"offer_id": offer.id, "status": offer.status, "job_id": offer.job_id, "labour_id": offer.labour_id}})
