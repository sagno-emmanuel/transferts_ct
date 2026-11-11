"""Routage racine : toutes les URL de l'application sont déléguées à transferts.urls."""
from django.urls import include, path

urlpatterns = [
    path("", include("transferts.urls")),
]
