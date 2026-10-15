-- 独立群组容器：每身份一个 kind='standalone' 的隐藏项目，承载不归属任何项目的群组。
ALTER TABLE projects ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'normal';
