"""Local job and client opportunity hunter.

This package is intentionally separate from the social-engagement automation so
job/client discovery can be developed and tested without touching the existing
LinkedIn/Instagram/Facebook/WhatsApp flows.
"""

from . import engine as engine
from .search_providers import install as _install_search_providers


_install_search_providers(engine)

__all__ = ["engine"]
