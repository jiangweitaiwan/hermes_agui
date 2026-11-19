"""One-shot Host lease reconciliation; schedule independently of HTTP CPU allocation."""

from hermes_agui.storage.host_settings import load_adapters, open_host_pool
from hermes_agui.storage.run_events import RunEvents


def main():
    pool, _profiles = load_adapters("profiles")
    try:
        open_host_pool(pool)
        print(f"Interrupted expired runs: {RunEvents(pool).reconcile()}")
    finally:
        pool.close()


if __name__ == "__main__":
    main()
