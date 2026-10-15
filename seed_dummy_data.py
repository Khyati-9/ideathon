import os
import random
import sys
from datetime import date, timedelta

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from django.db import transaction

from core.models import (
    FarmerProfile,
    JobRequirement,
    LabourProfile,
    Skill,
    SkillCategory,
    User,
)

random.seed(42)

# ---------- master data ----------

CATEGORIES = {
    "Harvesting": ("कापणी / तोडणी", [
        ("Tomato picking", "टोमॅटो तोडणी"),
        ("Onion harvesting", "कांदा काढणी"),
        ("Grape harvesting", "द्राक्ष तोडणी"),
        ("Pomegranate picking", "डाळिंब तोडणी"),
    ]),
    "Farming": ("शेती", [
        ("Spraying", "फवारणी"),
        ("Tractor driving", "ट्रॅक्टर चालवणे"),
        ("Weeding", "तण काढणे"),
        ("Planting", "लागवड"),
        ("Pruning", "छाटणी"),
    ]),
    "Nursery": ("रोपवाटिका", [
        ("Nursery work", "रोपवाटिका काम"),
    ]),
    "Packing & warehouse": ("पॅकिंग आणि गोदाम", [
        ("Packing / warehouse", "पॅकिंग / गोदाम"),
        ("Loading / unloading", "लोडिंग / अनलोडिंग"),
        ("Grading & stacking", "प्रतवारी आणि रचणी"),
    ]),
    "Construction": ("बांधकाम", [
        ("Construction helper", "बांधकाम मदतनीस"),
        ("Digging", "खोदकाम"),
        ("Mason helper", "गवंडी मदतनीस"),
    ]),
}

WAGE_RANGE = {  # (min, max) per person per day
    "Harvesting": (500, 800),
    "Farming": (450, 750),
    "Nursery": (400, 600),
    "Packing & warehouse": (450, 700),
    "Construction": (600, 900),
}

PLACES = {
    "Niphad": ["Pimpalgaon", "Lasalgaon", "Ozar", "Chandori", "Saykheda", "Kasbe Sukene"],
    "Sinnar": ["Musalgaon", "Nandur Shingote", "Malegaon", "Wavi", "Dodi"],
    "Dindori": ["Vani", "Kopargaon", "Ranwad", "Khedgaon", "Mohadi"],
    "Nashik": ["Girnare", "Adgaon", "Ozar Mig", "Makhmalabad", "Shilapur"],
    "Igatpuri": ["Ghoti", "Tringalwadi", "Wadivarhe", "Bhavli"],
    "Yeola": ["Anandwadi", "Pimpri", "Nagadwadi", "Rajapur"],
    "Chandwad": ["Dahivad", "Wadner", "Rahud", "Shirasgaon"],
}

FIRST = ["Ramesh", "Suresh", "Vishnu", "Ganesh", "Dattatray", "Sanjay", "Prakash",
         "Anil", "Sunil", "Mahesh", "Shivaji", "Balu", "Kisan", "Nana", "Vitthal",
         "Sita", "Lata", "Sunita", "Mangal", "Kamal", "Rekha", "Asha", "Sangeeta"]
LAST = ["Pawar", "Jadhav", "Shinde", "More", "Gaikwad", "Bhosale", "Kale", "Wagh",
        "Thorat", "Deshmukh", "Sonawane", "Patil", "Chavan", "Nikam", "Gawali"]

PAY_METHODS = ["Daily wage / per day", "Per acre", "Fixed amount for complete work", "Per hour"]
LAST_SOURCES = ["By going to the labour naka", "Labour contractor", "Personal contacts",
                "WhatsApp group", "Farmer contacted directly"]


def rand_name():
    return f"{random.choice(FIRST)} {random.choice(LAST)}"


def rand_place():
    taluka = random.choice(list(PLACES))
    return taluka, random.choice(PLACES[taluka])


def make_phones(n, used):
    out = []
    while len(out) < n:
        p = random.choice("6789") + "".join(random.choices("0123456789", k=9))
        if p not in used:
            used.add(p)
            out.append(p)
    return out


# ---------- seeding steps ----------

def seed_skills():
    skills = []
    for cat_name, (cat_mr, items) in CATEGORIES.items():
        cat, _ = SkillCategory.objects.update_or_create(
            name_en=cat_name, defaults={"name_mr": cat_mr}
        )
        for name_en, name_mr in items:
            skill, _ = Skill.objects.update_or_create(
                name_en=name_en, defaults={"name_mr": name_mr, "category": cat}
            )
            skills.append(skill)
    return skills


def seed_farmers(n_farmers, skills, used_phones):
    phones = make_phones(n_farmers, used_phones)
    users = User.objects.bulk_create([
        User(username=f"dummy_{p}", first_name=rand_name(), phone=p,
             role=User.Role.FARMER, password="!")
        for p in phones
    ])

    farmers = []
    for u in users:
        taluka, village = rand_place()
        farmers.append(FarmerProfile(
            user=u, district="Nashik", taluka=taluka, village=village,
            meta={"dummy": True},
        ))
    farmers = FarmerProfile.objects.bulk_create(farmers)

    jobs, job_skill_names = [], []
    today = date.today()
    for f in farmers:
        for _ in range(random.randint(1, 3)):
            chosen = random.sample(skills, random.randint(1, 2))
            cat = chosen[0].category.name_en
            lo, hi = WAGE_RANGE[cat]
            jobs.append(JobRequirement(
                farmer=f, district="Nashik", taluka=f.taluka, village=f.village,
                category=cat,
                job_type=chosen[0].name_en,
                work_date=today + timedelta(days=random.randint(1, 30)),
                workers_needed=random.randint(2, 20),
                farm_size=round(random.uniform(0.5, 15), 1),
                wage_offered=random.randrange(lo, hi + 1, 50),
                payment_method=random.choice(PAY_METHODS),
                contact_preference="Yes, phone or WhatsApp",
                meta={"dummy": True},
            ))
            job_skill_names.append(chosen)
    jobs = JobRequirement.objects.bulk_create(jobs)

    Through = JobRequirement.skills.through
    Through.objects.bulk_create([
        Through(jobrequirement_id=j.id, skill_id=s.id)
        for j, chosen in zip(jobs, job_skill_names) for s in chosen
    ])
    return len(farmers), len(jobs)


def seed_labour(n_labour, skills, used_phones):
    phones = make_phones(n_labour, used_phones)
    users = User.objects.bulk_create([
        User(username=f"dummy_{p}", first_name=rand_name(), phone=p,
             role=User.Role.LABOURER, password="!")
        for p in phones
    ])

    profiles, skill_sets = [], []
    today = date.today()
    for u in users:
        taluka, village = rand_place()
        chosen = random.sample(skills, random.randint(1, 4))
        lo, hi = WAGE_RANGE[chosen[0].category.name_en]
        is_team = random.random() < 0.25
        availability = random.choices(["now", "week", "later"], weights=[60, 25, 15])[0]
        if availability == "now":
            a_from, a_to = today, today + timedelta(days=30)
        elif availability == "week":
            a_from, a_to = today, today + timedelta(days=7)
        else:
            a_from = today + timedelta(days=random.randint(8, 20))
            a_to = a_from + timedelta(days=30)

        profiles.append(LabourProfile(
            user=u, district="Nashik", taluka=taluka, village=village,
            type="team" if is_team else "individual",
            team_name=f"{village} group" if is_team else "",
            team_size=random.randint(3, 15) if is_team else 1,
            preferred_work=chosen[0].name_en,
            expected_wage=random.randrange(lo, hi + 1, 50),
            worked_days=random.randint(0, 30),
            travel_km=random.choice([5, 10, 15, 20, 30]),
            availability=availability,
            available_from=a_from, available_to=a_to,
            last_work_source=random.choice(LAST_SOURCES),
            contact_preference="Yes, phone or WhatsApp",
            meta={"dummy": True},
        ))
        skill_sets.append(chosen)
    profiles = LabourProfile.objects.bulk_create(profiles)

    Through = LabourProfile.skills.through
    Through.objects.bulk_create([
        Through(labourprofile_id=p.id, skill_id=s.id)
        for p, chosen in zip(profiles, skill_sets) for s in chosen
    ])
    return len(profiles)


def clear_dummy():
    deleted, _ = User.objects.filter(username__startswith="dummy_").delete()
    print(f"Deleted {deleted} dummy rows (users and everything linked to them)")


# ---------- run ----------

if __name__ == "__main__":
    args = sys.argv[1:]
    if "--clear" in args:
        clear_dummy()
        sys.exit(0)

    n_farmers = int(args[0]) if len(args) > 0 else 300
    n_labour = int(args[1]) if len(args) > 1 else 800

    with transaction.atomic():
        skills = seed_skills()
        used = set(User.objects.values_list("phone", flat=True))
        farmers, jobs = seed_farmers(n_farmers, skills, used)
        labour = seed_labour(n_labour, skills, used)

    print(f"Skills: {len(skills)} | Farmers: {farmers} | Jobs: {jobs} | Labour: {labour}")