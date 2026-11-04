# deploy.sh CRLF 导致 pipefail 无效

日期：2026-08-21

## 现象

`set: pipefail` 下一行单独一个 `:`，`invalid option name`；supervisord FATAL。

## 原因

Windows CRLF：`pipefail\r` 被当成选项名。

## 修复

1. `imagebed/deploy.sh` 改为 LF；`pack-sseinfra.ps1` 写入时强制 LF  
2. `sseinfra-pod` 解压后 `sed` 去 `\r`  
3. 重打 `imagebed-sseinfra.zip`

上传新 zip 再部署即可（可选：同步含 sed 的 sdpy-api dist）。
