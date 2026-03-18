"""Server-side RSS fetcher for IT News Feed PWA — runs in GitHub Actions."""
import feedparser, json, os, re
from datetime import datetime, timezone

FEEDS = {
    'global': [
        {'url': 'https://thehackernews.com/feeds/posts/default',            'name': 'The Hacker News',   'category': 'Security'},
        {'url': 'https://krebsonsecurity.com/feed/',                        'name': 'Krebs on Security', 'category': 'Security'},
        {'url': 'https://thenewstack.io/feed/',                             'name': 'The New Stack',     'category': 'DevOps'},
        {'url': 'https://devops.com/feed/',                                 'name': 'DevOps.com',        'category': 'DevOps'},
        {'url': 'https://feeds.arstechnica.com/arstechnica/technology-lab', 'name': 'Ars Technica',      'category': 'Tech'},
        {'url': 'https://feed.infoq.com/',                                  'name': 'InfoQ',             'category': 'Engineering'},
    ],
    'indonesia': [
        {'url': 'https://tekno.kompas.com/rss/',          'name': 'Kompas Tekno',   'category': 'Tech'},
        {'url': 'https://rss.detik.com/inet',             'name': 'Detik iNet',     'category': 'Tech'},
        {'url': 'https://rss.tempo.co/tekno',             'name': 'Tempo Tekno',    'category': 'Tech'},
        {'url': 'https://www.cnbcindonesia.com/tech/rss', 'name': 'CNBC Indonesia', 'category': 'Tech'},
    ],
}

def strip_html(t):
    if not t: return ''
    t = re.sub(r'<[^>]+>', ' ', t)
    t = re.sub(r'&[a-zA-Z#0-9]+;', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()

def trunc(t, n):
    t = t.strip()
    return t[:n].rstrip() + '\u2026' if len(t) > n else t

def to_iso(entry):
    ts = getattr(entry, 'published_parsed', None) or getattr(entry, 'updated_parsed', None)
    if ts:
        try: return datetime(*ts[:6], tzinfo=timezone.utc).isoformat()
        except: pass
    return ''

def sort_key(item):
    try: return datetime.fromisoformat(item['pubDate']).timestamp()
    except: return 0.0

os.makedirs('feeds', exist_ok=True)

for tab, configs in FEEDS.items():
    items = []
    for c in configs:
        try:
            feed = feedparser.parse(c['url'])
            added = 0
            for e in feed.entries:
                if added >= 20: break
                link = getattr(e, 'link', '') or ''
                if not link.startswith('https://'): continue
                title = trunc(strip_html(getattr(e, 'title', '') or ''), 120)
                raw = (getattr(e, 'summary', '') or getattr(e, 'description', '')
                       or (e.content[0].get('value', '') if hasattr(e, 'content') and e.content else ''))
                if not title: continue
                items.append({'title': title, 'summary': trunc(strip_html(raw), 200),
                              'link': link, 'pubDate': to_iso(e),
                              'source': c['name'], 'category': c['category']})
                added += 1
            print(f"  {c['name']}: {added} items")
        except Exception as ex:
            print(f"  ERROR {c['name']}: {ex}")
    items.sort(key=sort_key, reverse=True)
    out = {'fetchedAt': datetime.now(timezone.utc).isoformat(), 'items': items}
    with open(f'feeds/{tab}.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f"Saved {len(items)} items -> feeds/{tab}.json")

print('Done.')
