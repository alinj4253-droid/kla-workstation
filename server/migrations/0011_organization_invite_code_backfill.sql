ALTER TABLE organizations ADD COLUMN IF NOT EXISTS invite_code text;
UPDATE organizations
SET invite_code = upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8))
WHERE invite_code IS NULL OR invite_code = '';
ALTER TABLE organizations ALTER COLUMN invite_code SET DEFAULT upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8));
ALTER TABLE organizations ALTER COLUMN invite_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_invite_code_idx ON organizations(invite_code);
