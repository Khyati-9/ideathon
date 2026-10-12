from django.urls import path

from . import views

urlpatterns = [
    path("farmer/", views.farmer_signup, name="farmer-signup"),
    path("labour/", views.labour_signup, name="labour-signup"),
    path("demo/farmers/", views.demo_farmers, name="demo-farmers"),
    path("farmer/profile/", views.farmer_profile, name="farmer-profile"),
    path("farmer/jobs/<int:job_id>/matches/", views.job_matches, name="job-matches"),
]