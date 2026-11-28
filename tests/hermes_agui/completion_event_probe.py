"""Real Host participant for PG event-chain acceptance; no Scheduler or GCP."""
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg_pool import ConnectionPool
from hermes_agui.storage.completion_delivery import stage_evidence
from hermes_agui.storage.completion_http import mount_completion
from hermes_agui.storage.objects import FilesystemObjects
from hermes_agui.storage.profile import BotScope, ProfileObjects, ProfileRevision
from hermes_agui.storage.run_outbox import PostgresRunOutbox
from hermes_agui.storage.runs import PostgresRunStore


def main():
    namespace, root, url = json.loads(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    scope = BotScope(namespace['projectId'], namespace['principal'], namespace['botId'])
    os.environ['AGUI_GRAPH_COMPLETION_URL'] = url + '/internal/graph/completions'
    os.environ['AGUI_GRAPH_COMPLETION_TOKEN'] = 'runtime-fixture-' + 'a'*32
    profiles = ProfileObjects(FilesystemObjects(root))
    with ConnectionPool(os.environ['HERMES_AGUI_TEST_RUNTIME_DATABASE_URL'], min_size=1, max_size=4) as pool:
        from hermes_agui.storage.epoch import epoch
        with pool.connection() as conn:
            current = epoch(conn)
            profiles.epoch = current
            if current:
                profiles.prefix = 'epochs/' + current + '/profiles'
            conn.execute('INSERT INTO hermes_agui_host.bot_state(project,principal,bot) VALUES(%s,%s,%s)',
                         (scope.project,scope.principal,scope.bot))
        outbox, notifications = PostgresRunOutbox(pool), []
        def notify(identifier):
            assert outbox.state(identifier) == 'pending'
            notifications.append({'schema':2,'epoch':current,'eventId':str(identifier)} if current else {'schema':1,'eventId':str(identifier)})
            assert client.post('/internal/completions/process',json=notifications[-1],
                headers={'x-completion-token':'completion-fixture-'+'b'*32}).status_code == 204
        runs = PostgresRunStore(pool, publish_completions=True, completion_tasks=SimpleNamespace(notify=notify))
        storage = SimpleNamespace(runs=runs, profiles=profiles,
                                  completion_tasks=SimpleNamespace(token='completion-fixture-'+'b'*32))
        app = FastAPI()
        mount_completion(app, storage)
        client = TestClient(app)
        turn = SimpleNamespace(thread_id='thread',run_id='run',message_id='message',text='研究資料庫備份')
        result = {'final_response':'資料庫的備份決定需要保存已提交的資料以及原始的證據，才能驗證恢復過程，並且確保重新部署後可以繼續讀取。'}
        lease = runs.begin(scope, turn.thread_id, turn.run_id, uuid4(), 90)
        profile = ProfileRevision(uuid4().hex, ())
        generation = stage_evidence(profiles,scope,profile.revision,turn,result)
        assert runs.finish(lease,status='completed',profile=profile,evidence_generation=generation)
        assert len(notifications) == 1
        assert outbox.state(int(notifications[0]['eventId'])) == 'delivered'
        assert client.post('/internal/completions/process',json=notifications[0],
            headers={'x-completion-token':'completion-fixture-'+'b'*32}).status_code == 204
        print(json.dumps({'delivered':True,'notifications':len(notifications),'run':'completed'}))


if __name__ == '__main__':
    main()
