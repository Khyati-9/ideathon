from django.contrib.auth.models import AbstractUser
from django.core.validators import RegexValidator
from django.db import models


# ---------- shared building blocks ----------

class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class LocationMixin(models.Model):
    """Free text now. Later: replace with FKs to District/Taluka/Village
    tables in one place instead of touching every model."""
    district = models.CharField(max_length=100, blank=True)
    taluka = models.CharField(max_length=100, blank=True)
    village = models.CharField(max_length=100, blank=True)

    class Meta:
        abstract = True


# ---------- identity ----------

phone_validator = RegexValidator(r"^\d{10}$", "Enter a 10 digit number")


class User(AbstractUser, TimeStampedModel):
    class Role(models.TextChoices):
        FARMER = "farmer", "Farmer"
        LABOURER = "labourer", "Labourer"

    # Phone number is the identity (OTP login later).
    phone = models.CharField(
        max_length=10, unique=True, validators=[phone_validator]
    )
    alternate_phone = models.CharField(
        max_length=10, blank=True, validators=[phone_validator]
    )
    role = models.CharField(max_length=10, choices=Role.choices, blank=True)

    def __str__(self):
        return f"{self.get_full_name() or self.username} ({self.phone})"


# ---------- master data ----------

class SkillCategory(models.Model):
    """Harvesting, Farming, Construction, ... Add new ones from admin."""
    name_en = models.CharField(max_length=100, unique=True)
    name_mr = models.CharField(max_length=100, blank=True)
    name_hi = models.CharField(max_length=100, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name_en"]
        verbose_name_plural = "skill categories"

    def __str__(self):
        return self.name_en


class Skill(models.Model):
    category = models.ForeignKey(
        SkillCategory,
        on_delete=models.PROTECT,
        related_name="skills",
        null=True,
        blank=True,
    )
    name_en = models.CharField(max_length=100, unique=True)
    name_mr = models.CharField(max_length=100, blank=True)
    name_hi = models.CharField(max_length=100, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name_en"]

    def __str__(self):
        return self.name_en


# ---------- farmer side ----------

class FarmerProfile(TimeStampedModel, LocationMixin):
    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="farmer_profile"
    )
    meta = models.JSONField(default=dict, blank=True)

    def __str__(self):
        return f"Farmer: {self.user}"


class JobRequirement(TimeStampedModel, LocationMixin):
    class Status(models.TextChoices):
        OPEN = "open", "Open"
        FILLED = "filled", "Filled"
        CLOSED = "closed", "Closed"

    farmer = models.ForeignKey(
        FarmerProfile, on_delete=models.CASCADE, related_name="jobs"
    )
    skills = models.ManyToManyField(Skill, related_name="jobs", blank=True)

    category = models.CharField(max_length=50, blank=True)
    job_type = models.CharField(max_length=100, blank=True)
    work_date = models.DateField(null=True, blank=True)
    workers_needed = models.PositiveIntegerField(null=True, blank=True)
    farm_size = models.DecimalField(
        max_digits=6, decimal_places=2, null=True, blank=True
    )

    wage_offered = models.DecimalField(
        max_digits=8, decimal_places=2, null=True, blank=True
    )
    payment_method = models.CharField(max_length=50, blank=True)
    contact_preference = models.CharField(max_length=30, blank=True)

    status = models.CharField(
        max_length=10, choices=Status.choices, default=Status.OPEN
    )
    meta = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["status", "work_date"]),
            models.Index(fields=["taluka", "status"]),
        ]

    def __str__(self):
        return f"{self.job_type or 'Job'} on {self.work_date or 'TBD'} at {self.village}"


# ---------- labour side (individual or team) ----------

class LabourProfile(TimeStampedModel, LocationMixin):
    class Type(models.TextChoices):
        INDIVIDUAL = "individual", "Individual"
        TEAM = "team", "Team"

    class Availability(models.TextChoices):
        NOW = "now", "Available now"
        WEEK = "week", "Available this week"
        LATER = "later", "Available from a later date"

    user = models.OneToOneField(
        User, on_delete=models.CASCADE, related_name="labour_profile"
    )

    # individual or team (a team is one leader profile with a headcount)
    type = models.CharField(
        max_length=10, choices=Type.choices, default=Type.INDIVIDUAL
    )
    team_name = models.CharField(max_length=100, blank=True)
    team_size = models.PositiveIntegerField(default=1)

    skills = models.ManyToManyField(Skill, related_name="labour_profiles", blank=True)
    preferred_work = models.CharField(max_length=100, blank=True)
    expected_wage = models.DecimalField(
        max_digits=8, decimal_places=2, null=True, blank=True
    )
    worked_days = models.PositiveSmallIntegerField(null=True, blank=True)
    travel_km = models.PositiveIntegerField(default=10)

    availability = models.CharField(
        max_length=10, choices=Availability.choices, default=Availability.NOW
    )
    available_from = models.DateField(null=True, blank=True)
    available_to = models.DateField(null=True, blank=True)
    is_available = models.BooleanField(default=True)

    last_work_source = models.CharField(max_length=50, blank=True)
    contact_preference = models.CharField(max_length=30, blank=True)
    meta = models.JSONField(default=dict, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["taluka", "is_available"]),
            models.Index(fields=["available_from", "available_to"]),
        ]

    def save(self, *args, **kwargs):
        if self.type == self.Type.INDIVIDUAL:
            self.team_size = 1
            self.team_name = ""
        super().save(*args, **kwargs)

    def __str__(self):
        label = self.team_name or self.user.get_full_name() or self.user.phone
        return f"{label} ({self.type}, {self.team_size})"

# ---------- matching ----------

class JobMatch(TimeStampedModel):
    """Stored result of the matcher: one row per (job, labour profile) pair
    that passed the hard rules. Both screens read from this table."""
    job = models.ForeignKey(
        JobRequirement, on_delete=models.CASCADE, related_name="matches"
    )
    labour = models.ForeignKey(
        LabourProfile, on_delete=models.CASCADE, related_name="matches"
    )
    score = models.PositiveSmallIntegerField()  # 0 to 100
    breakdown = models.JSONField(default=dict, blank=True)  # points per factor

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["job", "labour"], name="unique_job_labour_match"
            )
        ]
        indexes = [
            models.Index(fields=["job", "-score"]),
            models.Index(fields=["labour", "-score"]),
        ]
        ordering = ["-score"]

    def __str__(self):
        return f"{self.job_id} ↔ {self.labour_id} ({self.score})"


class Offer(TimeStampedModel):
    """Farmer picks a labourer for a job; the labourer accepts or rejects."""
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        REJECTED = "rejected", "Rejected"
        WITHDRAWN = "withdrawn", "Withdrawn by farmer"

    job = models.ForeignKey(
        JobRequirement, on_delete=models.CASCADE, related_name="offers"
    )
    labour = models.ForeignKey(
        LabourProfile, on_delete=models.CASCADE, related_name="offers"
    )
    wage = models.DecimalField(max_digits=8, decimal_places=2)  # per person per day
    headcount = models.PositiveIntegerField(default=1)  # people covered by this offer
    status = models.CharField(
        max_length=10, choices=Status.choices, default=Status.PENDING
    )
    message = models.CharField(max_length=300, blank=True)
    responded_at = models.DateTimeField(null=True, blank=True)
    meta = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["job", "labour"], name="unique_job_labour_offer"
            )
        ]
        indexes = [
            models.Index(fields=["labour", "status"]),
            models.Index(fields=["job", "status"]),
        ]
        ordering = ["-created_at"]

    def __str__(self):
        return f"Offer {self.job_id} → {self.labour_id} ({self.status})"