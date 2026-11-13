"""Protocol ordering, thread handoff, bounded buffers and safe projections."""

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

from ag_ui.core import Event
from pydantic import TypeAdapter
import pytest

from hermes_agui.config import ServerConfig
from hermes_agui.event_bridge import EventBridge
from hermes_agui.message_adapter import TurnInput


def bridge(**kwargs):
    return EventBridge(TurnInput("thread", "run", "user", "hello"), asyncio.Event(),
                       ServerConfig("secret", **kwargs))


async def collect(value, producer):
    task = asyncio.create_task(asyncio.to_thread(producer, value))
    result = [event async for event in value.events(task)]
    for event in result:
        TypeAdapter(Event).validate_python(event.model_dump(by_alias=True))
    return result


def types(events):
    return [event.type.value for event in events]


@pytest.mark.asyncio
async def test_live_deltas_arrive_before_native_completion_and_are_not_replayed():
    value = bridge()
    release = asyncio.Event()
    first = asyncio.Event()

    async def worker():
        await asyncio.to_thread(value.delta, "hel")
        await release.wait()
        await asyncio.to_thread(value.delta, "lo")
        return {"completed": True, "final_response": "hello"}

    task = asyncio.create_task(worker())
    output = []

    async def consume():
        async for event in value.events(task):
            output.append(event)
            if event.type.value == "TEXT_MESSAGE_CONTENT":
                first.set()

    consumer = asyncio.create_task(consume())
    await asyncio.wait_for(first.wait(), 10)
    assert not task.done()
    release.set()
    await asyncio.wait_for(consumer, 10)
    assert types(output) == ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT",
                             "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]
    assert "".join(e.delta for e in output if hasattr(e, "delta")) == "hello"
    assert len({e.message_id for e in output if hasattr(e, "message_id")}) == 1


@pytest.mark.asyncio
async def test_multiple_tool_rounds_interim_dedup_and_result_ids():
    def produce(value):
        for index in range(3):
            value.delta(f"checking {index}")
            value.delta(None)
            value.interim(f"checking {index}", already_streamed=True)
            args = {"secret": "NEVER PUBLIC"}
            value.tool_start(f"call-{index}", "terminal", args)
            value.tool_start(f"call-{index}", "terminal", args)
            value.tool_complete(f"call-{index}", "terminal", args, "SECRET KEY")
            value.tool_complete(f"call-{index}", "terminal", args, "SECRET KEY")
        value.delta("finished")
        value.delta(None)
        return {"completed": True, "final_response": "finished"}

    output = await collect(bridge(), produce)
    assert types(output)[-1] == "RUN_FINISHED"
    starts = [e for e in output if e.type.value == "TOOL_CALL_START"]
    assert [e.tool_call_id for e in starts] == [f"call-{i}" for i in range(3)]
    for call in starts:
        related = [e for e in output if getattr(e, "tool_call_id", None) == call.tool_call_id]
        assert types(related) == ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"]
        assert json.loads(related[1].delta) == {"content": "[withheld]"}
    assert len([e for e in output if e.type.value == "TEXT_MESSAGE_CONTENT"]) == 4
    assert "SECRET" not in "".join(e.model_dump_json() for e in output)


@pytest.mark.asyncio
async def test_parallel_tool_callbacks_and_explicit_safe_result_projection():
    def produce(value):
        def tool(index):
            value.tool_start(str(index), "probe", {"key": "private"})
            value.tool_complete(str(index), "probe", {}, {"error": "private failure"})

        with ThreadPoolExecutor(max_workers=3) as executor:
            list(executor.map(tool, range(3)))
        return {"completed": True, "final_response": "handled tool failures"}

    value = bridge(tool_projection=lambda kind, _name, _raw: {"status": "failed"} if kind == "result" else {})
    output = await collect(value, produce)
    results = [e for e in output if e.type.value == "TOOL_CALL_RESULT"]
    assert len(results) == 3
    assert all(json.loads(e.content) == {"status": "failed"} for e in results)
    assert output[-1].type.value == "RUN_FINISHED"


@pytest.mark.asyncio
@pytest.mark.parametrize("limits", [{"event_capacity": 1}, {"event_bytes": 2}])
async def test_slow_consumer_overflow_fails_closed_and_requests_cancel(limits):
    value = bridge(**limits)
    # No consumer yet: overflow is deterministic, independent of thread speed.
    await asyncio.to_thread(lambda: [value.delta("large") for _ in range(3)])
    task = asyncio.create_task(asyncio.to_thread(lambda: {"completed": True, "final_response": "answer"}))
    output = [e async for e in value.events(task)]
    assert value.failed and value.stop.is_set()
    assert types(output)[-1] == "RUN_ERROR"
    assert "RUN_FINISHED" not in types(output)


@pytest.mark.asyncio
async def test_projection_failure_is_generic_and_partial_text_closes_before_error():
    def bad_projection(*_args):
        raise ValueError("PRIVATE CREDENTIAL")

    def produce(value):
        value.delta("visible partial")
        value.tool_start("one", "probe", {})
        return {"failed": True}

    output = await collect(bridge(tool_projection=bad_projection), produce)
    assert types(output)[-2:] == ["TEXT_MESSAGE_END", "RUN_ERROR"]
    assert "PRIVATE" not in "".join(e.model_dump_json() for e in output)


@pytest.mark.asyncio
async def test_final_fallback_and_unstreamed_interim_are_separate_messages():
    def produce(value):
        value.interim("working")
        value.tool_start("one", "probe", {})
        value.tool_complete("one", "probe", {}, "done")
        return {"completed": True, "final_response": "answer"}

    output = await collect(bridge(), produce)
    contents = [e for e in output if e.type.value == "TEXT_MESSAGE_CONTENT"]
    assert [e.delta for e in contents] == ["working", "answer"]
    assert contents[0].message_id != contents[1].message_id


@pytest.mark.asyncio
async def test_partial_interim_and_final_fallback_append_only_missing_suffixes():
    def produce(value):
        value.delta("checking")
        value.interim("checking now", already_streamed=False)
        value.delta("final")
        return {"completed": True, "final_response": "final answer"}

    output = await collect(bridge(), produce)
    contents = [e for e in output if e.type.value == "TEXT_MESSAGE_CONTENT"]
    assert [e.delta for e in contents] == ["checking", " now", "final", " answer"]
    assert contents[0].message_id == contents[1].message_id
    assert contents[2].message_id == contents[3].message_id != contents[0].message_id
    assert types(output)[-1] == "RUN_FINISHED"
