const messages: Record<string, readonly [string, string]> = {
  SYNC_AUTHENTICATION_FAILED: ['认证失败，请检查账号、密码或访问密钥。', 'Authentication failed. Check the username, password or access keys.'],
  SYNC_PERMISSION_DENIED: ['权限不足，请检查账号对备份目录的读取、创建、上传和删除权限。', 'Permission denied. Check read, create, upload and delete access to the backup directory.'],
  SYNC_ENDPOINT_MISSING: ['服务地址不存在，请检查 WebDAV 地址和账号的起始目录，避免重复填写路径。', 'Endpoint not found. Check the WebDAV URL and the account’s base directory for a repeated path.'],
  SYNC_REMOTE_DIRECTORY_MISSING: ['无法创建备份目录，请检查服务地址和上级目录。', 'The backup directory could not be created. Check the endpoint and parent directory.'],
  SYNC_REMOTE_DIRECTORY_INVALID: ['备份目录不可用，请确认路径指向文件夹且服务支持创建目录。', 'The backup directory is unavailable. Check that the path is a folder and the service supports directory creation.'],
  SYNC_BUCKET_MISSING: ['存储桶不存在，请检查名称和服务地址。', 'Bucket not found. Check its name and endpoint.'],
  SYNC_REMOTE_WRITE_FAILED: ['云端写入失败，请检查备份目录和存储服务状态。', 'Remote write failed. Check the backup directory and storage service.'],
  SYNC_REMOTE_READ_FAILED: ['云端读取失败，请检查备份目录的读取权限和服务状态。', 'Remote read failed. Check read access to the backup directory and the storage service.'],
  SYNC_TEST_CLEANUP_FAILED: ['读写验证已通过，但临时测试文件未能删除，请检查删除权限后重试。', 'Read and write checks passed, but the temporary test file could not be deleted. Check delete access and retry.'],
  SYNC_CHECKSUM_FAILED: ['上传后读取的内容不一致，请检查存储服务。', 'Downloaded contents differ from the uploaded data. Check the storage service.'],
  SYNC_QUOTA_EXCEEDED: ['云端存储空间不足，请释放空间后重试。', 'Remote storage is full. Free up space and retry.'],
  SYNC_REDIRECT_REFUSED: ['服务地址发生重定向，请填写最终的 WebDAV 或 S3 服务地址。', 'The endpoint redirected. Enter the final WebDAV or S3 endpoint.'],
  SYNC_WEBDAV_UNAVAILABLE: ['此地址未提供可用的 WebDAV 服务，请检查服务地址。', 'WebDAV is unavailable at this endpoint. Check the service URL.'],
  SYNC_S3_UNAVAILABLE: ['无法访问 S3 存储桶，请检查服务地址、区域和存储桶设置。', 'The S3 bucket could not be accessed. Check the endpoint, region and bucket settings.'],
  SYNC_REMOTE_DELETE_FAILED: ['云端文件删除失败，请检查删除权限。', 'Remote deletion failed. Check delete access.'],
  SYNC_REMOTE_CONFLICT: ['云端已存在不同内容的同名备份对象，请检查备份目录。', 'A remote backup object has conflicting contents. Check the backup directory.'],
  SYNC_INVALID_RESPONSE: ['服务返回了无法识别的响应，请检查 WebDAV 或 S3 地址。', 'The service returned an invalid response. Check the WebDAV or S3 endpoint.'],
  BACKUP_PASSWORD_REQUIRED: ['请填写凭据备份的加密口令后重试。', 'Enter the encryption password for credential backups and retry.'],
  BACKUP_SCHEDULE_UNAVAILABLE: ['自动备份配置无法读取，请检查备份设置。', 'Automatic backup settings could not be read. Check the backup settings.'],
  BACKUP_FAILED: ['本地备份创建失败，请查看数据存储状态后重试。', 'The local backup could not be created. Check the data storage status and retry.'],
  SYNC_NETWORK_ERROR: ['无法连接存储服务，请检查地址和网络后重试。', 'The storage service could not be reached. Check the endpoint and network, then retry.'],
  SYNC_CONFIGURATION_INVALID: ['云备份连接配置无法读取，请检查备份设置。', 'The cloud backup connection settings could not be read. Check the backup settings.'],
  SYNC_SNAPSHOT_CHANGED: ['本地备份在上传时发生变化，请重新创建备份。', 'The local backup changed during upload. Create a new backup.'],
  SYNC_SNAPSHOT_MISSING: ['待上传的本地备份不存在，请重新创建备份。', 'The local backup to upload is missing. Create a new backup.'],
  SYNC_TIMEOUT: ['连接测试超时，请检查网络和存储服务后重试。', 'The connection test timed out. Check the network and storage service, then retry.'],
}

export function cloudBackupError(error: unknown, english: boolean): string {
  const code = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').match(/\b(?:SYNC_[A-Z_]+|BACKUP_[A-Z_]+|CREDENTIAL_STORE_UNAVAILABLE)\b/)?.[0]
  if (code === 'CREDENTIAL_STORE_UNAVAILABLE')
    return english ? 'Secure storage is unavailable. Credentials have not been saved.' : '系统安全存储不可用，凭据尚未保存。'
  return (code && messages[code]?.[english ? 1 : 0]) || (english ? 'The operation did not complete. Retry, or check the logs for diagnostic information.' : '操作未完成，请重试；若持续失败，可在日志中查看诊断信息。')
}
