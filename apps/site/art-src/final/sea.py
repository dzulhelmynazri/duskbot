# the ending picture: end-sea.png cleaned up into public/landing/art/end-sea.webp
#   python3 art-src/final/sea.py   (run from sites/madani)
from PIL import Image
import numpy as np, random

def clean_sky(im, width=7):
    a = np.asarray(im).astype(np.int16); hsv = np.asarray(im.convert('HSV'))
    blue = (hsv[..., 0] >= 122) & (hsv[..., 0] <= 160) & (hsv[..., 1] > 40)
    p = np.pad(a, ((0, 0), (width // 2, width // 2), (0, 0)), mode='edge')
    flat = np.median(np.stack([p[:, i:i + a.shape[1]] for i in range(width)]), axis=0)
    return Image.fromarray(np.where(blue[..., None], flat, a).astype(np.uint8))

im = clean_sky(Image.open('art-src/final/end-sea.png').convert('RGB')).resize((1600, 1067), Image.LANCZOS)
a = np.asarray(im).astype(np.int16).copy(); h, w, _ = a.shape
H, SAND = 668, 985
sea_top, sky = np.array([130, 235, 247]), np.array([2, 205, 255])
water = lambda r: (r[..., 2] > 200) & (r[..., 0] < 200)

# the pale strip at the horizon becomes sea
band = a[H:716]; band[(band[..., 2] > 230) & (band[..., 0] < 200)] = sea_top; a[H:716] = band

# the white glints on the water go: a pale, cool pixel takes the colour of the water around it in its row
# (sails and hulls are warm, their red is above their blue, so they stay)
sea = a[H:SAND]
glint = (sea[..., 0] > 150) & (sea[..., 2] >= sea[..., 0]) & (sea.sum(-1) > 610)
# grow the mask a few pixels so the soft edge around each glint goes too
for _ in range(3):
    g = glint.copy(); g[1:] |= glint[:-1]; g[:-1] |= glint[1:]; g[:, 1:] |= glint[:, :-1]; g[:, :-1] |= glint[:, 1:]
    glint = g & (sea[..., 2] >= sea[..., 0])
for y in range(sea.shape[0]):
    row, g = sea[y], glint[y]
    if not g.any(): continue
    ok = ~g & (row[..., 2] > row[..., 0])
    if ok.any(): row[g] = np.median(row[ok], axis=0)

# any speck still lighter than its row by a clear margin goes the same way
boats = [(20, 740, 170, 910), (950, 690, 1170, 930), (1440, 740, 1580, 890)]
keep = np.zeros(sea.shape[:2], bool)
for x0, y0, x1, y1 in boats: keep[max(0, y0 - H):y1 - H, x0:x1] = True
for y in range(sea.shape[0]):
    row = sea[y]; cool = (row[..., 2] >= row[..., 0]) & ~keep[y]
    if not cool.any(): continue
    med = np.median(row[cool], axis=0)
    speck = ~keep[y] & (row.sum(-1) > med.sum() + 24)
    row[speck] = med

# the sea's top edge gets stepped pixel waves, like the other bands
random.seed(11)
for x in range(0, w, 16):
    off = random.choice([-2, -1, -1, 0, 1, 1, 2]) * 7
    blk = a[:, x:x + 16]
    if off > 0: r = blk[H:H + off]; r[water(r)] = sky
    elif off < 0: r = blk[H + off:H]; r[water(r)] = sea_top

Image.fromarray(a.astype(np.uint8)).save('public/landing/art/end-sea.webp', quality=86, method=6)
