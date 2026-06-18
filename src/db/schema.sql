-- Users
CREATE TABLE IF NOT EXISTS users (
  id          VARCHAR(50) PRIMARY KEY,
  phone       VARCHAR(20) UNIQUE NOT NULL,
  username    VARCHAR(50) NOT NULL,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  last_seen   TIMESTAMPTZ DEFAULT NOW()
);

-- Chats (direct or group)
CREATE TABLE IF NOT EXISTS chats (
  id              VARCHAR(50) PRIMARY KEY,
  type            VARCHAR(10) NOT NULL CHECK (type IN ('direct', 'group')),
  name            VARCHAR(100),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW()
);

-- Who is in each chat
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id    VARCHAR(50) REFERENCES chats(id) ON DELETE CASCADE,
  user_id    VARCHAR(50) REFERENCES users(id) ON DELETE CASCADE,
  role       VARCHAR(10) DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id          VARCHAR(50) PRIMARY KEY,
  chat_id     VARCHAR(50) REFERENCES chats(id) ON DELETE CASCADE,
  sender_id   VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
  text        TEXT,
  status      VARCHAR(10) DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_members_user_id ON chat_members(user_id);