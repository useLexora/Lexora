export const BUDDY_V28_AVATARS_SCHEMA_SQL = `
ALTER TABLE buddies ADD COLUMN custom_avatars_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(custom_avatars_json) AND json_type(custom_avatars_json) = 'array');
UPDATE buddies SET custom_avatars_json = json_array(avatar) WHERE avatar IS NOT NULL;
`
