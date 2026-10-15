from django.urls import path

from . import views

urlpatterns = [
    path("farmer/", views.farmer_signup, name="farmer-signup"),
    path("labour/", views.labour_signup, name="labour-signup"),
    path("demo/farmers/", views.demo_farmers, name="demo-farmers"),
    path("farmer/profile/", views.farmer_profile, name="farmer-profile"),
    path("farmer/jobs/<int:job_id>/matches/", views.job_matches, name="job-matches"),
    path("demo/labour/", views.demo_labour, name="demo-labour"),
    path("labour/profile/", views.labour_profile, name="labour-profile"),
    path("labour/<int:labour_id>/jobs/", views.labour_jobs, name="labour-jobs"),
    path("otp/send/", views.send_otp, name="send_otp"),
    path("jobs/explore/", views.explore_jobs, name="explore-jobs"),
    path("workers/explore/", views.explore_workers, name="explore-workers"),
    path("offers/", views.create_offer, name="create-offer"),
    path("offers/<int:offer_id>/respond/", views.respond_offer, name="respond-offer"),
]
