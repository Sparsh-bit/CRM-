import { withReticle } from '@reticlehq/next';
/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  serverExternalPackages: ['exceljs', 'nodemailer', 'bcryptjs'],
};
export default withReticle(nextConfig);
