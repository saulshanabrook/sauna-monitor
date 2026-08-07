PRAGMA foreign_keys = ON;

CREATE TABLE readings (
  message_key TEXT PRIMARY KEY,
  observed_at_ms INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  inserted_at_ms INTEGER NOT NULL,
  application_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  dev_eui TEXT,
  session_key_id TEXT,
  f_port INTEGER,
  frame_counter INTEGER,
  temp_channel_1_c REAL,
  temp_channel_2_c REAL,
  sauna_temp_c REAL,
  stovepipe_temp_c REAL,
  sauna_rate_c_per_min REAL,
  stovepipe_rate_c_per_min REAL,
  battery_v REAL,
  rssi_dbm REAL,
  snr_db REAL
) WITHOUT ROWID;

CREATE INDEX readings_device_time_idx
  ON readings(device_id, observed_at_ms);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  last_hot_at_ms INTEGER NOT NULL,
  peak_sauna_c REAL,
  peak_stovepipe_c REAL,
  max_stovepipe_rate_c_per_min REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX sessions_started_at_idx
  ON sessions(started_at_ms);

CREATE UNIQUE INDEX sessions_one_open_per_device_idx
  ON sessions(device_id)
  WHERE ended_at_ms IS NULL;

CREATE TABLE detector_state (
  device_id TEXT PRIMARY KEY,
  updated_at_ms INTEGER NOT NULL,
  start_candidate_at_ms INTEGER,
  start_candidate_count INTEGER NOT NULL DEFAULT 0,
  open_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL
);
