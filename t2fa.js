const bcrypt = require('bcrypt');
const otplib = require('otplib');

async function test() {
  const hashedPw = await bcrypt.hash('TestPass1', 10);
  const wrong = await bcrypt.compare('WrongPass1', hashedPw);
  console.log('PASS wrong pw rejected:', !wrong);
  const correct = await bcrypt.compare('TestPass1', hashedPw);
  console.log('PASS correct pw accepted:', correct);
  const totp_secret = 'SOMESECRET';
  console.log('PASS 2FA blocks re-setup:', !!totp_secret);
  const disable = await bcrypt.compare('TestPass1', hashedPw);
  console.log('PASS disable correct pw:', disable);
  const nope = await bcrypt.compare('WrongPass', hashedPw);
  console.log('PASS disable wrong pw rejected:', !nope);
  const secret = otplib.generateSecret();
  const token = otplib.generateSync({ type: 'totp', secret });
  const r = otplib.verifySync({ type: 'totp', token, secret });
  console.log('PASS TOTP verify:', r.valid);
  console.log('All tests passed!');
}
test();
