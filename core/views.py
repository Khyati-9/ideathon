import json
from datetime import date
from decimal import Decimal, InvalidOperation
from django.db.models import Case, Count, IntegerField, Q, Value, When
from django.db import transaction

from .models import FarmerProfile, JobRequirement, LabourProfile, Skill, User

from django.conf import settings
from django.db.models import Count, Q
from django.http import Http404, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST


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


# ---------- farmer form ----------

@csrf_exempt
@require_POST
def farmer_signup(request):
    data = _body(request)
    if data is None:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    phone = _phone(data.get("phone"))
    if not phone:
        return _phone_error()

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


# ---------- labour form (individual or team) ----------

@csrf_exempt
@require_POST
def labour_signup(request):
    data = _body(request)
    if data is None:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    phone = _phone(data.get("phone"))
    if not phone:
        return _phone_error()

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
    GET /api/farmer/profile/?phone=1234567890"""
    phone = _phone(request.GET.get("phone"))
    if not phone:
        return _phone_error()

    try:
        farmer = FarmerProfile.objects.select_related("user").get(user__phone=phone)
    except FarmerProfile.DoesNotExist:
        return JsonResponse(
            {"error": "No farmer profile found for this number"}, status=404
        )

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
def job_matches(request, job_id):
    """Labour profiles (individuals and mukkadams/teams) matching one job.
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

    # nearness to the job: same village 2, same taluka 1
    whens = []
    if job.village:
        whens.append(When(village__iexact=job.village, then=Value(2)))
    if job.taluka:
        whens.append(When(taluka__iexact=job.taluka, then=Value(1)))
    labour = labour.annotate(
        nearness=Case(*whens, default=Value(0), output_field=IntegerField())
    ).order_by("-skill_match", "-nearness", "expected_wage", "id")

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