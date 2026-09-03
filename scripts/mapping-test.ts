import { autoMap, splitName, normalizePhone, isValidEmail } from '../src/lib/import/mapping';

let fails = 0;
const check = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${n}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`pass ${n}`);
};

const m1 = autoMap(['Company Name', 'Contact Name', 'Email']).map;
check('company column maps to company', m1.company, 'Company Name');
check('contact column maps to full name', m1.fullName, 'Contact Name');
check('email column maps to email', m1.email, 'Email');

check('designation → title', autoMap(['Designation']).map.title, 'Designation');
check('mobile no → phone', autoMap(['Mobile No.']).map.phone, 'Mobile No.');
check('sector → industry', autoMap(['Sector']).map.industry, 'Sector');
check('unmapped preserved', autoMap(['Email', 'Pitch', 'Notes']).unmapped, ['Pitch', 'Notes']);

check('honorific stripped', splitName('Dr. Siddeek Ahmed'), { firstName: 'Siddeek', lastName: 'Ahmed' });
check('nickname in brackets dropped', splitName('Mohammed Hamidul Hoque (Shamim)'), { firstName: 'Mohammed', lastName: 'Hamidul Hoque' });
check('role placeholder rejected', splitName('CEO'), { firstName: '', lastName: '' });
check('role placeholder rejected 2', splitName('Managing Director'), { firstName: '', lastName: '' });
check('lone initial rejected', splitName('A.'), { firstName: '', lastName: '' });
check('normal name', splitName('Rakesh Mishra'), { firstName: 'Rakesh', lastName: 'Mishra' });

check('local number gets cc', normalizePhone('0504745465', '966'), '+966504745465');
check('already international', normalizePhone('+966 57 664 1072', '966'), '+966576641072');
check('junk rejected', normalizePhone('n/a', '966'), null);
check('too short rejected', normalizePhone('12345', ''), null);

check('email ok', isValidEmail('a.b@c.co.in'), true);
check('email bad', isValidEmail('not an email'), false);

console.log(fails ? `\n${fails} FAILED` : '\nall mapping tests passed');
process.exit(fails ? 1 : 0);
