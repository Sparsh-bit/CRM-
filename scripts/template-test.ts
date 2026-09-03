import { render, extractTags, resolveSpintax } from '../src/lib/template';

let fails = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${name}`);
}

check('plain tag', render('Hi {{first_name}}', { first_name: 'Rakesh' }).text, 'Hi Rakesh');
check('fallback used', render('Hi {{first_name | fallback: "there"}}', {}).text, 'Hi there');
check('fallback not reported missing', render('Hi {{first_name | fallback: "there"}}', {}).missing, []);
check('missing reported', render('Hi {{first_name}}', {}).missing, ['first_name']);
check('custom column key', render('{{research_summary}}', { 'Research Summary': 'Saudi contractor' }).text, 'Saudi contractor');
check('filter', render('{{company | upper}}', { company: 'eram group' }).text, 'ERAM GROUP');
check('filter + fallback', render('{{company | upper | fallback: "your team"}}', {}).text, 'your team');
check('spintax alone', resolveSpintax('{Hi|Hello} there', 'a').startsWith('H'), true);
check('spintax next to a merge tag',
  render('{Hi|Hello} {{first_name | fallback: "there"}}, from {{sender_company}}',
    { sender_company: 'Concilio' }, 's').text.includes('there, from Concilio'), true);
check('deterministic per seed',
  render('{a|b|c}', {}, 'seed-1').text === render('{a|b|c}', {}, 'seed-1').text, true);
check('extractTags', extractTags('{{a}} {{b | fallback: "x"}}'), ['a', 'b']);
check('value containing braces is not re-spun',
  render('{{note}}', { note: '{keep|this}' }).text, '{keep|this}');

console.log(fails ? `\n${fails} FAILED` : '\nall template tests passed');
process.exit(fails ? 1 : 0);
