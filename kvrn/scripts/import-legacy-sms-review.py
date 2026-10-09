#!/usr/bin/env python3
"""Private operator-only legacy subscriber import. Runs in Codespaces, NOT on Worker.

Usage: python3 scripts/import-legacy-sms-review.py PATH_ACTIVE.csv PATH_UNSUBSCRIBED.csv
Required: direct Neon production URL, locally entered using getpass (never printed).
The 53 active-list records stay REVIEW REQUIRED, never subscribed; STOPs become
canonical suppressions unless a *later* signed JOIN->YES proof exists. The two
historical order exports are not commerce data and MUST NOT be imported here.
"""
import csv, datetime as dt, getpass, hashlib, json, re, sys
from pathlib import Path
from urllib.parse import urlsplit

EXPECTED_HOST = 'ep-lively-mouse-afchw3aq.c-2.us-west-2.aws.neon.tech'
REQUIRED_ACTIVE = {'customer_id', 'phone_number', 'subscriber_created_at_utc', 'last_keyword_subscribed_to'}
REQUIRED_UNSUB = {'customer_id', 'phone_number', 'subscriber_created_at_utc', 'opt_out_time', 'opt_out_reason'}

def die(why):
    raise SystemExit('STOP: ' + why)

def parse_time(value, required=False):
    value = (value or '').strip()
    if not value:
        if required: die('Required timestamp absent')
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        die('Unrecognized timestamp in source export')
    if parsed.tzinfo is None: parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed

def phone(value):
    value = (value or '').strip()
    if not re.fullmatch(r'[\d+() .-]+', value): die('Unrecognized phone format')
    digits = re.sub(r'\D', '', value)
    if len(digits) == 10: digits = '1' + digits
    if len(digits) < 8 or len(digits) > 15 or digits[0] == '0': die('Invalid E.164 number')
    return '+' + digits

def read(path, required):
    path = Path(path).resolve()
    if not path.is_file(): die('Input CSV file missing')
    if path.stat().st_size > 5_000_000: die('CSV unexpectedly large')
    with path.open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        if not required.issubset(reader.fieldnames or []): die('Wrong CSV export headers')
        records = list(reader)
    if not records: die('Empty subscriber export')
    return records

def main():
    if len(sys.argv) != 3: die('Usage: python3 scripts/import-legacy-sms-review.py ACTIVE.csv UNSUBSCRIBED.csv')
    active = read(sys.argv[1], REQUIRED_ACTIVE)
    stopped = read(sys.argv[2], REQUIRED_UNSUB)
    states = {}
    for item in active:
        p = phone(item['phone_number'])
        if p in states: die('Duplicate active phone detected; reconcile before import')
        states[p] = {'state':'review_required', 'customer':(item['customer_id'] or '').strip()[:128],
                     'keyword':(item['last_keyword_subscribed_to'] or '').strip()[:80],
                     'joined':parse_time(item['subscriber_created_at_utc']), 'optout':None,'reason':None}
    for item in stopped:
        p = phone(item['phone_number'])
        optout = parse_time(item['opt_out_time'], required=True)
        if p in states: die('An unsubscribed phone also appears active: STOP and reconcile dates')
        states[p] = {'state':'suppressed', 'customer':(item['customer_id'] or '').strip()[:128],
                     'keyword':(item.get('keyword_subscribed_to') or '').strip()[:80],
                     'joined':parse_time(item['subscriber_created_at_utc']),
                     'optout':optout, 'reason':(item.get('opt_out_reason') or '')[:150]}
    if len(states) > 50_000: die('Unexpected input size')
    digest = hashlib.sha256(json.dumps(
        [(p, v['state'], v['keyword'], v['joined'].isoformat() if v['joined'] else '',
          v['optout'].isoformat() if v['optout'] else '') for p,v in sorted(states.items())],
        ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    print('IMPORT PREVIEW: total',len(states),'review-required',sum(v['state']=='review_required' for v in states.values()),
          'suppressed',sum(v['state']=='suppressed' for v in states.values()),
          'keyword reported',sum(bool(v['keyword']) for v in states.values()))
    print('SOURCE FINGERPRINT:', digest[:16], '(no phone numbers disclosed)')
    print('ACTIVE CONTACTS WILL NOT BE ENABLED FOR MARKETING SENDS.')
    url = getpass.getpass('Production Neon DIRECT URL (hidden): ').strip()
    if not url: die('Missing URL')
    parsed = urlsplit(url)
    if parsed.hostname != EXPECTED_HOST or parsed.path != '/neondb' or parsed.scheme not in ('postgres','postgresql'):
        die('Not the pinned production Neon host or database')
    try:
        import psycopg
    except ImportError:
        die('Missing psycopg in Codespaces Python; do not install into app environment blindly')
    with psycopg.connect(url, connect_timeout=12) as con:
        with con.cursor() as cur:
            cur.execute('SELECT current_database(), current_setting(\'transaction_read_only\'), to_regclass(\'public.legacy_sms_import_contacts\')::text')
            db, read_only, table = cur.fetchone()
            if db != 'neondb': die('Unexpected database')
            if table is None:
                print('Migration 066 not present; applying additive quarantine table DDL first')
                sqlfile = Path(__file__).resolve().parent.parent / 'db/migrations/066_legacy_sms_import_review_and_suppression.sql'
                if not sqlfile.is_file(): die('SQL migration 066 missing')
                ddl = sqlfile.read_text()
                if 'DROP ' in ddl or 'TRUNCATE ' in ddl: die('Dangerous migration text')
            else:
                ddl = None
            if read_only == 'on': die('Read-only connection: cannot import')
            con.commit()  # End the read-only discovery transaction before any migration DDL.
            confirm = input('Type IMPORT LEGACY SMS QUARANTINE to write (NO sends): ').strip()
            if confirm != 'IMPORT LEGACY SMS QUARANTINE': die('Not approved; no writes')
            if ddl:
                cur.execute(ddl)
                con.commit()
            # Atomically quarantine active and unsubscribed data. Never promote to valid opt-in.
            with con.transaction():
                for p, v in sorted(states.items()):
                    cur.execute('''
                        INSERT INTO legacy_sms_import_contacts
                            (phone_e164,legacy_customer_id,record_state,reported_keyword,legacy_created_at,
                             opted_out_at,opted_out_reason,import_batch_sha256)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                        ON CONFLICT(phone_e164) DO UPDATE
                        SET record_state=CASE WHEN legacy_sms_import_contacts.record_state='suppressed'
                                 OR EXCLUDED.record_state='suppressed' THEN 'suppressed' ELSE 'review_required' END,
                            reported_keyword=COALESCE(EXCLUDED.reported_keyword, legacy_sms_import_contacts.reported_keyword),
                            opted_out_at=COALESCE(GREATEST(legacy_sms_import_contacts.opted_out_at,EXCLUDED.opted_out_at),
                                                   legacy_sms_import_contacts.opted_out_at,EXCLUDED.opted_out_at),
                            opted_out_reason=COALESCE(EXCLUDED.opted_out_reason,legacy_sms_import_contacts.opted_out_reason),
                            import_batch_sha256=EXCLUDED.import_batch_sha256,updated_at=NOW()
                    ''', (p,v['customer'] or None,v['state'],v['keyword'] or None,v['joined'],v['optout'],v['reason'],digest))
                    if v['state'] == 'suppressed':
                        # Legacy STOP suppression: do not override a newer explicitly verified JOIN->YES.
                        cur.execute('''
                            INSERT INTO sms_subscribers
                               (phone_e164,status,consent_source,consented_at,unsubscribed_at,twilio_opt_out_state)
                            VALUES (%s,'unsubscribed','manual_admin',%s,%s,NULL)
                            ON CONFLICT (phone_e164) DO UPDATE
                            SET status='unsubscribed',
                                unsubscribed_at=GREATEST(sms_subscribers.unsubscribed_at,EXCLUDED.unsubscribed_at),
                                twilio_opt_out_state=CASE WHEN sms_subscribers.twilio_opt_out_state='opted_out' THEN 'opted_out' ELSE NULL END,updated_at=NOW()
                            WHERE NOT EXISTS (
                               SELECT 1 FROM sms_keyword_consent_proofs proof
                               WHERE proof.subscriber_id=sms_subscribers.id
                                 AND proof.confirmed_at>EXCLUDED.unsubscribed_at
                            )
                        ''',(p,v['joined'] or v['optout'],v['optout']))
            print('SUCCESS: legacy contacts staged for consent review, known opt-outs suppressed. NO MESSAGES SENT.')
            print('Local source CSVs must remain outside Git; never commit exports.')

if __name__ == '__main__': main()
