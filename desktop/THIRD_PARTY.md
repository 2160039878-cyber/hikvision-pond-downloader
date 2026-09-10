# 组件来源与分发边界

- Electron 44.3.0，来源 npm 官方 electron 包及其官方二进制下载器；依赖版本固定于 package-lock.json。Electron 使用 MIT 许可，Chromium 等组件的许可见程序目录 LICENSE 和 LICENSES.chromium.html，须一同保留。
- FFmpeg 9.0.1 essentials，来源 https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.1-essentials_build.zip 。上游压缩包 SHA256：fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9。
- FFmpeg 构建为 GPLv3；随包保留上游 LICENSE、README.txt（含库版本）、版权信息。FFmpeg 源码对应 https://github.com/FFmpeg/FFmpeg/commit/bf1b838f2a ，构建来源与外部库信息见 https://www.gyan.dev/ffmpeg/builds/ 。本工具通过独立进程调用，不链接修改 FFmpeg。
- 对外再分发前，分发者还需确保提供所分发 FFmpeg 构建的完整对应源码、依赖源码和构建材料；仅有上述主项目链接不能代替完整对应源码义务。本次仅交付本地预览与构建记录，不创建对外二进制 Release。
- 海康 HCNetSDK：不随源码或预览包分发。检测用户本机的 iVMS 或其自行合法取得的 SDK。SDK 再分发授权未确认，因此完整免安装版本发布被阻止。
- 接口定义参考海康官方 GetFileByTime、FindFile_V30、NET_DVR_IPPARACFG_V40 文档；结构常量交叉核对 NTU-ROSE/Hikvision_Video_Downloader 中的 HCNetSDK.h，未将该头文件和第三方 DLL 提交仓库。
- 源码上传不包含现场数据、截图、运行凭据或验收录像。Windows 启动入口未进行代码签名。
