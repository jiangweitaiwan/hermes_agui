"""Explicit local startup-only ADC/object double; mounted on container PYTHONPATH."""
import os
from pathlib import Path

from hermes_agui.storage.objects import FilesystemObjects, GCSObjects

def install_startup_double():
    if os.environ.get("NODE_ENV") != "test":
        raise SystemExit("Local SDK probe requires NODE_ENV=test")

    # no-tmp: ok — mounted local container startup-only object double
    GCSObjects.from_adc = staticmethod(lambda _bucket: FilesystemObjects(Path("/tmp/startup-objects")))


install_startup_double()
