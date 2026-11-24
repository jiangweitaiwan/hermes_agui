"""Execute a single native turn in a process that owns its profile writers."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from functools import partial
from multiprocessing import get_context
from threading import Lock


_STREAM_CALLBACKS = (
    "stream_delta_callback", "interim_assistant_callback",
    "tool_start_callback", "tool_complete_callback",
)


def _run_worker(output, config, thread_id, text, run_id, reference, callback_names, delegation, release_id=None,release_fingerprint=None):
    from agent.runtime_reference import runtime_reference
    from hermes_agui.core import HermesAgentService

    write_lock = Lock()

    def emit(name, *args, **kwargs):
        with write_lock:
            output.send((name, args, kwargs))

    runtime_reference.set(reference)
    callbacks = {name: partial(emit, name) for name in callback_names}
    try:
        if delegation is not None:
            from hermes_agui.delegation import _execution, register_tool

            register_tool(config.home)
            config = replace(config, enabled_toolsets=(*config.enabled_toolsets, "agui_bots"))
            _execution.set((delegation, None, None))
        with HermesAgentService(config, max_workers=1, max_pending=1) as service:
            pinned = {"registry": config.llm_registry, "release_id": release_id,
                      "release_fingerprint":release_fingerprint} if release_id else {}
            result = service.run(thread_id, text, run_id=run_id, callbacks=callbacks, **pinned)
        fields = ("completed", "failed", "partial", "interrupted", "final_response", "native_session_id")
        emit("result", {key: result[key] for key in fields if key in result})
    except Exception:  # health: allow BLE001 -- exceptions can include model credentials and prompt content
        emit("result", {"failed": True})
    finally:
        output.close()


class IsolatedAgentService:
    def __init__(self, config, *, authorize=None):
        self.config, self.authorize = config, authorize
        self._executor = ThreadPoolExecutor(max_workers=1)
        self._process = None
        self._lock = Lock()
        self._cancelled = False

    def submit(self, thread_id, text, *, run_id, callbacks=None, registry=None, release_id=None,release_fingerprint=None):
        from agent.runtime_reference import runtime_reference
        from hermes_agui.delegation import _execution

        if self.authorize is not None:
            self.authorize(self.config.principal, thread_id)
        callbacks = callbacks or {}
        execution = _execution.get()
        delegation = execution[0] if execution else None
        config = replace(self.config, llm_registry=registry) if registry and release_id else self.config
        return self._executor.submit(self._run, thread_id, text, run_id, runtime_reference.get(), callbacks, delegation, config, release_id,release_fingerprint)

    def _run(self, thread_id, text, run_id, reference, callbacks, delegation, config, release_id,release_fingerprint):
        context = get_context("spawn")
        reader, writer = context.Pipe(duplex=False)
        names = tuple(name for name in _STREAM_CALLBACKS if name in callbacks)
        process = context.Process(target=_run_worker, args=(
            writer, config, thread_id, text, run_id, reference, names, delegation, release_id,release_fingerprint,
        ))
        try:
            with self._lock:
                if self._cancelled:
                    return {"interrupted": True}
                process.start()
                self._process = process
            writer.close()
            return self._read_result(process, reader, callbacks)
        finally:
            with self._lock:
                if self._process is process:
                    if process.is_alive():
                        process.kill()
                    process.join()
                    self._process = None
            reader.close()
            writer.close()
            process.close()

    def _read_result(self, process, reader, callbacks):
        try:
            while True:
                name, args, kwargs = reader.recv()
                if name == "result":
                    process.join(timeout=10)
                    return args[0] if process.exitcode == 0 else {"failed": True}
                callbacks[name](*args, **kwargs)
        except EOFError:
            return {"interrupted": True} if self._cancelled else {"failed": True}

    def cancel(self, thread_id, run_id):
        with self._lock:
            self._cancelled = True
            if self._process is not None and self._process.is_alive():
                self._process.kill()
        return True

    def close(self):
        self._executor.shutdown(wait=True, cancel_futures=True)
