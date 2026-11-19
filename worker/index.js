// FromCom-sivuston Worker: tarjouslomakkeen lähetys (POST /api/tarjous).
// Muut pyynnöt palvelee staattinen sivusto (dist/) suoraan.
//
// Asetukset (Cloudflare → fromcom → Settings → Variables and secrets, EI Build-osio):
//   RESEND_API_KEY  (Secret)    Resend-palvelun API-avain
//   TARJOUS_EMAIL   (Variable)  Kenelle tarjouspyynnöt lähetetään, esim. arto.from@fromcom.fi
//   FROM_EMAIL      (Variable)  Lähettäjä. Oletus "FromCom-sivusto <onboarding@resend.dev>"
//                               (toimii vain testissä Resend-tilin omaan osoitteeseen;
//                               oikeassa käytössä vahvistettu domain, esim. sivusto@fromcom.fi)

const MAX_KUVAT = 4;
const MAX_KUVA_TAVUT = 4 * 1024 * 1024; // yksittäinen kuva base64-purun jälkeen
const MAX_PYYNTO_TAVUT = 20 * 1024 * 1024;
const MIN_TAYTTOAIKA_MS = 4000; // botit lähettävät lomakkeen heti

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/tarjous') {
      if (request.method !== 'POST') return json({ ok: false, virhe: 'Väärä pyyntö.' }, 405);
      try {
        return await kasitteleTarjous(request, env);
      } catch (e) {
        console.error('Tarjouspyynnön käsittely epäonnistui', e);
        return json({ ok: false, virhe: 'Lähetys epäonnistui. Yritä uudelleen tai soita meille.' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function kasitteleTarjous(request, env) {
  const pituus = Number(request.headers.get('content-length') || 0);
  if (pituus > MAX_PYYNTO_TAVUT) return json({ ok: false, virhe: 'Kuvat ovat liian suuria.' }, 413);

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, virhe: 'Virheellinen pyyntö.' }, 400);
  }

  // Roskapostisuojaus: piilokenttä ja täyttöaika. Botille vastataan "ok", ettei se yritä uudelleen.
  if (data.yritys_www) return json({ ok: true });
  if (typeof data.aloitettu === 'number' && Date.now() - data.aloitettu < MIN_TAYTTOAIKA_MS) return json({ ok: true });

  const k = (n, max = 500) => String(data[n] ?? '').trim().slice(0, max);
  const t = {
    palvelu: k('palvelu', 100),
    kohde: k('kohde', 100),
    tyot: Array.isArray(data.tyot) ? data.tyot.map((x) => String(x).slice(0, 100)).slice(0, 10) : [],
    pintaala: k('pintaala', 20),
    suunnitelmat: k('suunnitelmat', 100),
    kulkuyhteys: k('kulkuyhteys', 100),
    sijainti: k('sijainti', 100),
    aikataulu: k('aikataulu', 100),
    tapa: k('tapa', 20) === 'sahkoposti' ? 'sahkoposti' : 'puhelin',
    nimi: k('nimi', 120),
    puhelin: k('puhelin', 40),
    email: k('email', 200),
    viesti: k('viesti', 5000),
  };

  const virheet = [];
  if (!t.palvelu) virheet.push('palvelu');
  if (!t.nimi) virheet.push('nimi');
  if (!t.sijainti) virheet.push('sijainti');
  if (t.tapa === 'puhelin' && t.puhelin.replace(/\D/g, '').length < 6) virheet.push('puhelin');
  if (t.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t.email)) virheet.push('email');
  if (t.tapa === 'sahkoposti' && !t.email) virheet.push('email');
  if (virheet.length) return json({ ok: false, virhe: 'Tarkista lomakkeen tiedot.', kentat: virheet }, 400);

  const kuvat = [];
  for (const kuva of (Array.isArray(data.kuvat) ? data.kuvat : []).slice(0, MAX_KUVAT)) {
    const sisalto = String(kuva?.data ?? '');
    const tyyppi = String(kuva?.tyyppi ?? '');
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(tyyppi)) continue;
    if (sisalto.length * 0.75 > MAX_KUVA_TAVUT) continue;
    const nimi = String(kuva?.nimi ?? 'kuva').replace(/[^\w.\-äöåÄÖÅ ]/g, '_').slice(0, 80) || 'kuva';
    kuvat.push({ filename: nimi, content: sisalto });
  }

  if (!env.RESEND_API_KEY || !env.TARJOUS_EMAIL) {
    console.error('RESEND_API_KEY tai TARJOUS_EMAIL puuttuu asetuksista');
    return json({ ok: false, virhe: 'Lomakkeen lähetystä ei ole vielä otettu käyttöön. Soita tai lähetä sähköpostia.' }, 503);
  }

  const rivit = [
    ['Palvelu', t.palvelu],
    ['Kohde', t.kohde],
    ['Työhön kuuluu', t.tyot.join(', ')],
    ['Pinta-ala (arvio)', t.pintaala ? `${t.pintaala} m²` : ''],
    ['Suunnitelmat', t.suunnitelmat],
    ['Kulkuyhteys', t.kulkuyhteys],
    ['Sijainti', t.sijainti],
    ['Aikataulu', t.aikataulu],
  ].filter(([, v]) => v);
  const yhteys = [
    ['Nimi', t.nimi],
    ['Puhelin', t.puhelin],
    ['Sähköposti', t.email],
    ['Toivottu yhteydenotto', t.tapa === 'puhelin' ? 'Puhelimitse' : 'Sähköpostilla'],
  ].filter(([, v]) => v);

  const teksti = [
    'UUSI TARJOUSPYYNTÖ – fromcom.fi',
    '',
    ...rivit.map(([a, b]) => `${a}: ${b}`),
    '',
    ...yhteys.map(([a, b]) => `${a}: ${b}`),
    ...(t.viesti ? ['', 'Lisätietoja:', t.viesti] : []),
    ...(kuvat.length ? ['', `Liitteenä ${kuvat.length} kuva(a).`] : []),
  ].join('\n');

  const taulukko = (r) =>
    r.map(([a, b]) => `<tr><td style="padding:6px 16px 6px 0;color:#5d6163;vertical-align:top">${esc(a)}</td><td style="padding:6px 0;font-weight:600">${esc(b)}</td></tr>`).join('');
  const puhLinkki = t.puhelin ? `<a href="tel:${esc(t.puhelin.replace(/[^\d+]/g, ''))}" style="color:#181a19">${esc(t.puhelin)}</a>` : '';
  const html = `<!doctype html><html lang="fi"><body style="margin:0;background:#f4f3ef;font-family:Arial,sans-serif;color:#181a19">
<div style="max-width:600px;margin:0 auto;padding:24px">
<div style="background:#181a19;color:#ebeae6;padding:20px 24px;border-top:4px solid #e6a32e">
<div style="font-size:12px;letter-spacing:2px;color:#b9b8b2">FROMCOM.FI / TARJOUSPYYNTÖ</div>
<div style="font-size:24px;font-weight:700;margin-top:6px">${esc(t.palvelu)}${t.sijainti ? ', ' + esc(t.sijainti) : ''}</div>
</div>
<div style="background:#fff;padding:24px">
<h2 style="font-size:16px;margin:0 0 8px">Kohde ja työ</h2>
<table style="border-collapse:collapse;font-size:15px">${taulukko(rivit)}</table>
<h2 style="font-size:16px;margin:24px 0 8px">Yhteystiedot</h2>
<table style="border-collapse:collapse;font-size:15px">${taulukko(yhteys)}</table>
${t.viesti ? `<h2 style="font-size:16px;margin:24px 0 8px">Lisätietoja</h2><p style="font-size:15px;white-space:pre-wrap;margin:0">${esc(t.viesti)}</p>` : ''}
${kuvat.length ? `<p style="font-size:14px;color:#5d6163;margin:24px 0 0">Liitteenä ${kuvat.length} kuva(a) kohteesta.</p>` : ''}
${puhLinkki ? `<p style="margin:24px 0 0;font-size:15px">Soita asiakkaalle: ${puhLinkki}</p>` : ''}
</div></div></body></html>`;

  const vastaus = await fetch(env.RESEND_API_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.FROM_EMAIL || 'FromCom-sivusto <onboarding@resend.dev>',
      to: env.TARJOUS_EMAIL.split(',').map((s) => s.trim()).filter(Boolean),
      reply_to: t.email || undefined,
      subject: `Tarjouspyyntö: ${t.palvelu}${t.sijainti ? ', ' + t.sijainti : ''} – ${t.nimi}`,
      text: teksti,
      html,
      attachments: kuvat.length ? kuvat : undefined,
    }),
  });

  if (!vastaus.ok) {
    console.error('Resend-virhe', vastaus.status, await vastaus.text());
    return json({ ok: false, virhe: 'Lähetys epäonnistui. Yritä uudelleen tai soita meille.' }, 502);
  }
  return json({ ok: true });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
