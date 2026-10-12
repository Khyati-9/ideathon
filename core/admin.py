from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import (
    FarmerProfile,
    JobRequirement,
    LabourProfile,
    Skill,
    SkillCategory,
    User,
)

admin.site.site_header = "KaamSetu Admin"
admin.site.site_title = "KaamSetu"
admin.site.index_title = "Onboarding data"


# ---------- master data ----------

class SkillInline(admin.TabularInline):
    model = Skill
    extra = 0
    fields = ("name_en", "name_mr", "name_hi", "is_active")


@admin.register(SkillCategory)
class SkillCategoryAdmin(admin.ModelAdmin):
    list_display = ("name_en", "name_mr", "name_hi", "is_active")
    list_filter = ("is_active",)
    search_fields = ("name_en", "name_mr", "name_hi")
    inlines = [SkillInline]


@admin.register(Skill)
class SkillAdmin(admin.ModelAdmin):
    list_display = ("name_en", "name_mr", "name_hi", "category", "is_active")
    list_filter = ("category", "is_active")
    list_editable = ("category", "is_active")
    list_select_related = ("category",)
    search_fields = ("name_en", "name_mr", "name_hi", "category__name_en")
    autocomplete_fields = ("category",)


# ---------- users with their profiles ----------

class FarmerProfileInline(admin.StackedInline):
    model = FarmerProfile
    extra = 0
    can_delete = False
    fields = ("district", "taluka", "village", "meta")


class LabourProfileInline(admin.StackedInline):
    model = LabourProfile
    extra = 0
    can_delete = False
    filter_horizontal = ("skills",)
    fields = (
        ("type", "team_name", "team_size"),
        ("district", "taluka", "village"),
        "skills",
        ("preferred_work", "expected_wage"),
        ("worked_days", "travel_km"),
        ("availability", "available_from", "available_to", "is_available"),
        ("last_work_source", "contact_preference"),
        "meta",
    )


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    list_display = (
        "phone", "first_name", "alternate_phone", "role",
        "is_active", "created_at",
    )
    list_filter = ("role", "is_active", "is_staff", "created_at")
    search_fields = ("phone", "alternate_phone", "first_name", "last_name", "username")
    ordering = ("-created_at",)
    date_hierarchy = "created_at"
    readonly_fields = ("created_at", "updated_at", "last_login", "date_joined")

    fieldsets = DjangoUserAdmin.fieldsets + (
        ("KaamSetu", {"fields": ("phone", "alternate_phone", "role")}),
        ("Timestamps", {"fields": ("created_at", "updated_at")}),
    )
    add_fieldsets = DjangoUserAdmin.add_fieldsets + (
        ("KaamSetu", {"fields": ("phone", "alternate_phone", "role")}),
    )

    def get_inlines(self, request, obj):
        if obj is None:
            return []
        if obj.role == User.Role.FARMER:
            return [FarmerProfileInline]
        if obj.role == User.Role.LABOURER:
            return [LabourProfileInline]
        return []


# ---------- farmer side ----------

class JobRequirementInline(admin.TabularInline):
    model = JobRequirement
    extra = 0
    show_change_link = True
    fields = ("job_type", "work_date", "workers_needed", "wage_offered", "status")


@admin.register(FarmerProfile)
class FarmerProfileAdmin(admin.ModelAdmin):
    list_display = ("user", "phone", "district", "taluka", "village", "jobs_count", "created_at")
    list_filter = ("district", "taluka", "created_at")
    list_select_related = ("user",)
    search_fields = (
        "user__phone", "user__alternate_phone", "user__first_name",
        "district", "taluka", "village",
    )
    autocomplete_fields = ("user",)
    readonly_fields = ("created_at", "updated_at")
    date_hierarchy = "created_at"
    inlines = [JobRequirementInline]

    @admin.display(description="Phone", ordering="user__phone")
    def phone(self, obj):
        return obj.user.phone

    @admin.display(description="Jobs")
    def jobs_count(self, obj):
        return obj.jobs.count()


@admin.register(JobRequirement)
class JobRequirementAdmin(admin.ModelAdmin):
    list_display = (
        "job_type", "farmer", "phone", "village", "taluka", "work_date",
        "workers_needed", "wage_offered", "status", "created_at",
    )
    list_filter = ("status", "category", "skills__category", "taluka", "work_date", "created_at")
    list_editable = ("status",)
    list_select_related = ("farmer", "farmer__user")
    search_fields = (
        "job_type", "category", "village", "taluka", "district",
        "farmer__user__phone", "farmer__user__alternate_phone",
        "farmer__user__first_name", "skills__name_en", "skills__name_mr",
    )
    autocomplete_fields = ("farmer",)
    filter_horizontal = ("skills",)
    readonly_fields = ("created_at", "updated_at")
    date_hierarchy = "created_at"

    @admin.display(description="Phone", ordering="farmer__user__phone")
    def phone(self, obj):
        return obj.farmer.user.phone


# ---------- labour side ----------

@admin.register(LabourProfile)
class LabourProfileAdmin(admin.ModelAdmin):
    list_display = (
        "display_name", "phone", "type", "team_size", "village", "taluka",
        "preferred_work", "expected_wage", "availability", "is_available", "created_at",
    )
    list_filter = (
        "type", "availability", "is_available", "skills__category",
        "taluka", "last_work_source", "created_at",
    )
    list_editable = ("is_available",)
    list_select_related = ("user",)
    search_fields = (
        "user__phone", "user__alternate_phone", "user__first_name",
        "team_name", "preferred_work", "district", "taluka", "village",
        "skills__name_en", "skills__name_mr",
    )
    autocomplete_fields = ("user",)
    filter_horizontal = ("skills",)
    readonly_fields = ("created_at", "updated_at")
    date_hierarchy = "created_at"

    @admin.display(description="Name")
    def display_name(self, obj):
        return obj.team_name or obj.user.first_name or obj.user.phone

    @admin.display(description="Phone", ordering="user__phone")
    def phone(self, obj):
        return obj.user.phone