# photographs the seo pages' pictures. seo/art/scenes.json (written by node seo/art/scenes.mjs, and by every build) holds
# each page's scene laid out as html; this draws the ones that changed since last time (seo/art/rendered.json keeps a
# hash per picture) in headless chromium and writes, into public/landing/art/seo:
#   <id>.webp       the hero, 1320 by 528
#   <id>-660.webp   the hero for phones, 660 by 264
#   python3 seo/art/render.py [--all] [id ...]     (needs playwright for python; headless only)
import asyncio, glob, io, json, os, sys
from playwright.async_api import async_playwright
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
madani = os.path.abspath(os.path.join(here, '..', '..'))
art = os.path.join(madani, 'public', 'landing', 'art')
out = os.path.join(art, 'seo')
done_file = os.path.join(here, 'rendered.json')


async def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    everything = '--all' in sys.argv
    scenes = json.load(open(os.path.join(here, 'scenes.json')))
    done = json.load(open(done_file)) if os.path.exists(done_file) else {}
    if args:
        todo = [s for s in scenes if s['id'] in args]
    else:
        todo = [s for s in scenes if everything or done.get(s['id']) != s['hash'] or not os.path.exists(os.path.join(out, s['id'] + '.webp'))]
    if not todo:
        print('every picture is up to date')
        return
    async with async_playwright() as p:
        shells = sorted(glob.glob(os.path.expanduser('~/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')))
        browser = await p.chromium.launch(headless=True, args=['--use-mock-keychain', '--password-store=basic'], **({'executable_path': shells[-1]} if shells else {}))
        page = await browser.new_page(viewport={'width': 1320, 'height': 528})
        for s in todo:
            for mode, size in (('hero', (1320, 528)),):
                await page.set_viewport_size({'width': size[0], 'height': size[1]})
                tmp = os.path.join(art, f'_scene-{mode}.html')
                with open(tmp, 'w') as f:
                    f.write(s[mode])
                await page.goto('file://' + tmp)
                await page.evaluate('document.fonts.ready')
                await page.wait_for_function('[...document.images].every((i) => i.complete && i.naturalWidth > 0)')
                png = await page.screenshot(type='png')
                os.remove(tmp)
                im = Image.open(io.BytesIO(png)).convert('RGB')
                if mode == 'hero':
                    im.save(os.path.join(out, s['id'] + '.webp'), quality=80, method=6)
                    im.resize((660, 264), Image.LANCZOS).save(os.path.join(out, s['id'] + '-660.webp'), quality=80, method=6)
            done[s['id']] = s['hash']
            print(s['id'])
        await browser.close()
    # pictures of pages that are gone go too
    ids = {s['id'] for s in scenes}
    for f in glob.glob(os.path.join(out, '*.webp')):
        name = os.path.basename(f).rsplit('.', 1)[0].removesuffix('-660')
        if name not in ids:
            os.remove(f)
    json.dump({k: v for k, v in sorted(done.items()) if k in ids}, open(done_file, 'w'), indent=1)

asyncio.run(main())
