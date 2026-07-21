import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: '../../packages/database/src/schema/*.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './drizzle/mock.db',
  },
});
