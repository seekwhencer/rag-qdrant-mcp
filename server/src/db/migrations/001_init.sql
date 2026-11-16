CREATE TABLE IF NOT EXISTS files (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    path         VARCHAR(768)    NOT NULL,
    size         BIGINT UNSIGNED NULL,
    mtime        DATETIME(3)     NULL,
    ctime        DATETIME(3)     NULL,
    status       VARCHAR(16)     NOT NULL DEFAULT 'done',
    last_event   VARCHAR(16)     NULL,
    processed_at DATETIME(3)     NULL,
    deleted_at   DATETIME(3)     NULL,
    meta         JSON            NULL,
    created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                 ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_files_path (path),
    KEY idx_files_status (status),
    KEY idx_files_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
