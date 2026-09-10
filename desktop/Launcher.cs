using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
class Launcher {
 [STAThread] static void Main() {
  try {
   string dir=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"程序");
   string exe=Path.Combine(dir,"HikvisionAssistant.exe");
   if(!File.Exists(exe)) throw new Exception("请先完整解压，再运行开始.exe。程序文件夹必须保留在旁边。");
   Process.Start(new ProcessStartInfo(exe){WorkingDirectory=dir,UseShellExecute=false,CreateNoWindow=true});
  } catch(Exception e) {MessageBox.Show(e.Message,"海康录像下载助手");}
 }
}
