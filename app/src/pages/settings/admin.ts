import { Admin } from '@selfbound/core/app/admin';
import { app, convexUrl } from '../../app-instance.ts';

/** Settings operations (loaded only in this chunk). */
export const admin = new Admin(app);

/** Site URL of the HTTP endpoints (MCP); locally the backend port + 1. */
export const SITE_URL_ENV: string | undefined = import.meta.env.VITE_CONVEX_SITE_URL || undefined;
export const CONVEX_URL = convexUrl ?? '';
