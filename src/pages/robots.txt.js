// robots.txt: testiversiossa (PUBLIC_TESTI=true) estetään kaikki hakukoneet.
export function GET() {
  const testi = import.meta.env.PUBLIC_TESTI === 'true';
  const body = testi
    ? 'User-agent: *\nDisallow: /\n'
    : 'User-agent: *\nAllow: /\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
