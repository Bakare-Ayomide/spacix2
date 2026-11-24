-- Migration 003: Provider request/response diagnostic logs table.

CREATE TABLE IF NOT EXISTS provider_logs (
  id VARCHAR(64) PRIMARY KEY,
  provider_id VARCHAR(64) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  method VARCHAR(16) NOT NULL,
  status_code INT NULL,
  duration_ms INT NOT NULL DEFAULT 0,
  ok TINYINT(1) NOT NULL DEFAULT 0,
  error_message VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_pl_provider_created (provider_id, created_at),
  CONSTRAINT fk_pl_provider FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
