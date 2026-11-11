"""Routes de l'application Transferts CT."""
from django.urls import path

from . import views

app_name = "transferts"

urlpatterns = [
    path("", views.index, name="index"),
    path("api/rpc/<str:function_name>", views.rpc, name="rpc"),
    path("api/photos/<path:object_path>", views.photo, name="photo"),
]
