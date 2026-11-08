// Python source run with `python3 -I -` (fed on stdin). It reads the session
// registry in ~/.claude/sessions, keeps the live sessions that have Remote
// Control on (a bridgeSessionId), and for each one reads the tail of its
// transcript back to the last message that started a turn. It prints one JSON
// object: { scannedAt, sessions: [...] }. The env var SW_SELF names the
// session to leave out (the one running this mod).
export const SCANNER_SOURCE = String.raw`
import hashlib
import json
import os
from datetime import datetime, timezone

TAIL_BYTES = 4 * 1024 * 1024
HEAD_CHARS = 1200
END_CHARS = 2400
QUESTION_TOOLS = ('AskUserQuestion', 'ExitPlanMode')
QUIET_TOOL_SUFFIXES = ('wrap_up', 'update_plan')


def text_of(content):
    if isinstance(content, str):
        return content
    return '\n'.join(b.get('text', '') for b in content or [] if isinstance(b, dict) and b.get('type') == 'text')


def starts_turn(rec):
    if rec.get('type') != 'user' or rec.get('isMeta'):
        return False
    content = rec.get('message', {}).get('content')
    if isinstance(content, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in content):
        return False
    text = text_of(content).strip()
    return bool(text) and not text.startswith('<system-reminder>') and not text.startswith('<local-command')


def ask_text(name, tool_input):
    if name == 'ExitPlanMode':
        return 'Approvare il piano?'
    questions = tool_input.get('questions') or []
    return ' / '.join(q.get('question', '') for q in questions if isinstance(q, dict)) or 'Domanda in attesa'


def read_tail_records(path):
    size = os.path.getsize(path)
    start = max(0, size - TAIL_BYTES)
    with open(path, 'rb') as fh:
        fh.seek(start)
        data = fh.read()
    lines = data.split(b'\n')
    if start > 0:
        lines = lines[1:]
    newest_first = []
    last_at = None
    for raw in reversed(lines):
        raw = raw.strip()
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if rec.get('isSidechain'):
            continue
        if last_at is None and rec.get('timestamp'):
            last_at = rec['timestamp']
        if starts_turn(rec):
            break
        newest_first.append(rec)
    return list(reversed(newest_first)), last_at


def read_turn(path):
    records, last_at = read_tail_records(path)
    answered = set()
    pending = []
    wrap_ask = ''
    tail = []
    last_text = ''
    for rec in records:
        content = rec.get('message', {}).get('content')
        if not isinstance(content, list):
            continue
        if rec.get('type') == 'user':
            answered.update(b.get('tool_use_id') for b in content if isinstance(b, dict) and b.get('type') == 'tool_result')
            continue
        if rec.get('type') != 'assistant':
            continue
        for block in content:
            kind = block.get('type')
            if kind == 'text' and block.get('text', '').strip():
                tail.append(block['text'])
                last_text = block['text']
            elif kind == 'tool_use':
                name = block.get('name', '')
                if name.endswith(QUIET_TOOL_SUFFIXES):
                    if name.endswith('wrap_up'):
                        wrap_ask = (block.get('input') or {}).get('ask') or ''
                    continue
                tail = []
                if name in QUESTION_TOOLS:
                    pending.append(block)
    pending_ask = ' / '.join(ask_text(b.get('name'), b.get('input') or {}) for b in pending if b.get('id') not in answered)
    final = '\n\n'.join(tail) if tail else last_text
    if len(final) > HEAD_CHARS + END_CHARS:
        final = final[:HEAD_CHARS] + '\n[...]\n' + final[-END_CHARS:]
    return final.strip(), pending_ask, wrap_ask, last_at


def age_minutes(stamp, now):
    if not stamp:
        return None
    try:
        then = datetime.fromisoformat(stamp.replace('Z', '+00:00'))
    except ValueError:
        return None
    return max(0, int((now - then).total_seconds() // 60))


def main():
    registry = os.path.expanduser('~/.claude/sessions')
    projects = os.path.expanduser('~/.claude/projects')
    own_id = os.environ.get('SW_SELF', '')
    now = datetime.now(timezone.utc)
    sessions = []
    for entry_name in sorted(os.listdir(registry)):
        if not entry_name.endswith('.json'):
            continue
        try:
            with open(os.path.join(registry, entry_name)) as fh:
                entry = json.load(fh)
        except (OSError, ValueError):
            continue
        if not entry.get('bridgeSessionId') or entry.get('sessionId') == own_id:
            continue
        if not os.path.exists('/proc/%s' % entry.get('pid')):
            continue
        cwd = entry.get('cwd', '')
        path = os.path.join(projects, cwd.replace('/', '-'), entry['sessionId'] + '.jsonl')
        if not os.path.exists(path):
            continue
        final, pending_ask, wrap_ask, last_at = read_turn(path)
        status = 'busy' if entry.get('status') == 'busy' else 'idle'
        digest = hashlib.sha1('\x1f'.join([status, pending_ask, wrap_ask, final]).encode('utf-8')).hexdigest()
        sessions.append({'name': entry.get('name') or entry['sessionId'][:8], 'sessionId': entry['sessionId'], 'bridgeSessionId': entry['bridgeSessionId'], 'cwd': cwd, 'status': status, 'lastAt': last_at, 'ageMinutes': age_minutes(last_at, now), 'pendingAsk': pending_ask, 'wrapAsk': wrap_ask, 'lastText': final, 'digest': digest})
    print(json.dumps({'scannedAt': datetime.now().strftime('%H:%M'), 'sessions': sessions}, ensure_ascii=False))


main()
`
