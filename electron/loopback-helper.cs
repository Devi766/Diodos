// NetworkIsolation API Helper
// 通过 P/Invoke 调用 Windows NetworkIsolation API 管理 UWP 回环豁免
// 此文件由 PowerShell Add-Type 动态编译，不需要管理员权限

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class NetworkIsolationHelper
{
    // ===== 结构体定义 =====

    [StructLayout(LayoutKind.Sequential)]
    public struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INET_FIREWALL_AC_CAPABILITIES
    {
        public uint count;
        public IntPtr capabilities;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INET_FIREWALL_AC_BINARIES
    {
        public uint count;
        public IntPtr binaries;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INET_FIREWALL_APP_CONTAINER
    {
        public IntPtr appContainerSid;
        public IntPtr userSid;
        public IntPtr appContainerName;
        public IntPtr displayName;
        public IntPtr description;
        public INET_FIREWALL_AC_CAPABILITIES capabilities;
        public INET_FIREWALL_AC_BINARIES binaries;
        public IntPtr workingDirectory;
        public IntPtr packageFullName;
    }

    // ===== P/Invoke 声明 =====

    [DllImport("Firewallapi.dll")]
    public static extern uint NetworkIsolationEnumAppContainers(
        uint Flags, out uint pdwNumPublicAppCs, out IntPtr ppPublicAppCs);

    [DllImport("Firewallapi.dll")]
    public static extern uint NetworkIsolationGetAppContainerConfig(
        out uint pdwNumPublicAppCs, out IntPtr appContainerSids);

    [DllImport("Firewallapi.dll")]
    public static extern uint NetworkIsolationSetAppContainerConfig(
        uint dwNumPublicAppCs, [In] SID_AND_ATTRIBUTES[] appContainerSids);

    [DllImport("Firewallapi.dll")]
    public static extern void NetworkIsolationFreeAppContainers(IntPtr pPublicAppCs);

    [DllImport("advapi32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool ConvertSidToStringSid(IntPtr pSid, out IntPtr stringSid);

    [DllImport("advapi32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool ConvertStringSidToSid(string stringSid, out IntPtr pSid);

    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr hMem);

    // SHLoadIndirectString: 解析资源引用字符串（如 @{PackageName?ms-resource://...}）为本地化文本
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern int SHLoadIndirectString(
        string pszSource, StringBuilder pszOutBuf, uint cchOutBuf, IntPtr ppvReserved);

    // ===== 辅助方法 =====

    /// <summary>
    /// 将 SID 指针转换为字符串
    /// </summary>
    public static string SidToString(IntPtr pSid)
    {
        IntPtr stringSid;
        if (ConvertSidToStringSid(pSid, out stringSid))
        {
            string result = Marshal.PtrToStringAuto(stringSid);
            LocalFree(stringSid);
            return result;
        }
        return null;
    }

    /// <summary>
    /// JSON 字符串转义
    /// </summary>
    private static string JsonEscape(string s)
    {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"':  sb.Append("\\\""); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:   sb.Append(c); break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    /// <summary>
    /// 解析资源引用字符串为本地化文本
    /// displayName 通常是 @{PackageName?ms-resource://...} 格式的资源引用
    /// 使用 SHLoadIndirectString API 将其解析为当前系统语言的实际显示名称
    /// 如果解析失败，返回原始字符串（保留 @ 前缀以便上层识别并用其他方式解析）
    /// </summary>
    private static string ResolveDisplayName(string rawDisplayName, string fallback)
    {
        if (string.IsNullOrEmpty(rawDisplayName))
            return fallback ?? "";

        // 如果不是资源引用字符串（不以 @ 开头），直接返回
        if (!rawDisplayName.StartsWith("@"))
            return rawDisplayName;

        try
        {
            StringBuilder outBuf = new StringBuilder(1024);
            int hr = SHLoadIndirectString(rawDisplayName, outBuf, (uint)outBuf.Capacity, IntPtr.Zero);
            if (hr == 0 && outBuf.Length > 0)
            {
                return outBuf.ToString();
            }
        }
        catch
        {
            // 解析失败时静默回退
        }

        // SHLoadIndirectString 解析失败，返回 fallback（appContainerName）
        // 上层 JS 代码会通过 Get-AppxPackage 再次尝试解析
        return fallback ?? rawDisplayName;
    }

    // ===== 公开方法 =====

    /// <summary>
    /// 从 PackageFullName 提取 PackageFamilyName
    /// PackageFullName 格式: Name_Version_Architecture_ResourceId_PublisherId
    /// PackageFamilyName 格式: Name_PublisherId
    /// 例如: Microsoft.WindowsSoundRecorder_10.2403.20.0_x64__8wekyb3d8bbwe
    ///    -> Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe
    /// </summary>
    private static string ExtractPackageFamilyName(string packageFullName)
    {
        if (string.IsNullOrEmpty(packageFullName))
            return null;

        // PackageFullName 由 '_' 分隔的 5 个部分组成
        // 第一个部分是 Name，最后一个部分是 PublisherId
        string[] parts = packageFullName.Split('_');
        if (parts.Length >= 5)
        {
            // PackageFamilyName = Name_PublisherId
            return parts[0] + "_" + parts[parts.Length - 1];
        }

        // 如果格式不符合预期，返回 null
        return null;
    }

    /// <summary>
    /// 枚举所有 AppContainer 并返回 JSON 格式的应用列表（含豁免状态）
    /// </summary>
    public static string EnumAppContainers()
    {
        uint count = 0;
        IntPtr pContainers = IntPtr.Zero;
        uint result = NetworkIsolationEnumAppContainers(0, out count, out pContainers);

        if (result != 0)
        {
            return "{\"error\":\"EnumAppContainers failed with code: " + result + "\"}";
        }

        // 获取当前豁免列表
        HashSet<string> exemptSids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        uint exemptCount = 0;
        IntPtr pExemptSids = IntPtr.Zero;
        uint configResult = NetworkIsolationGetAppContainerConfig(out exemptCount, out pExemptSids);
        if (configResult == 0 && exemptCount > 0)
        {
            int sidAttrSize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
            for (uint i = 0; i < exemptCount; i++)
            {
                IntPtr cur = new IntPtr(pExemptSids.ToInt64() + i * sidAttrSize);
                SID_AND_ATTRIBUTES sa = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(
                    cur, typeof(SID_AND_ATTRIBUTES));
                string sidStr = SidToString(sa.Sid);
                if (sidStr != null) exemptSids.Add(sidStr);
            }
        }

        // 枚举应用并构建 JSON
        StringBuilder sb = new StringBuilder();
        sb.Append("[");
        int containerSize = Marshal.SizeOf(typeof(INET_FIREWALL_APP_CONTAINER));
        bool first = true;

        for (uint i = 0; i < count; i++)
        {
            IntPtr cur = new IntPtr(pContainers.ToInt64() + i * containerSize);
            INET_FIREWALL_APP_CONTAINER container =
                (INET_FIREWALL_APP_CONTAINER)Marshal.PtrToStructure(
                    cur, typeof(INET_FIREWALL_APP_CONTAINER));

            string sid = SidToString(container.appContainerSid);
            if (sid == null) continue;

            string name = Marshal.PtrToStringUni(container.appContainerName) ?? "";
            string rawDisplay = Marshal.PtrToStringUni(container.displayName) ?? "";
            string display = ResolveDisplayName(rawDisplay, name);
            string workDir = Marshal.PtrToStringUni(container.workingDirectory) ?? "";
            // 从 packageFullName 提取真正的 PackageFamilyName（Name_PublisherId 格式）
            string pkgFullName = Marshal.PtrToStringUni(container.packageFullName) ?? "";
            string pfn = ExtractPackageFamilyName(pkgFullName);

            bool isExempt = exemptSids.Contains(sid);

            if (!first) sb.Append(",");
            first = false;

            sb.Append("{");
            sb.Append("\"appContainerName\":" + JsonEscape(name) + ",");
            sb.Append("\"displayName\":" + JsonEscape(display) + ",");
            // packageFamilyName: 优先使用从 packageFullName 提取的真正 PFN，否则回退到 appContainerName
            sb.Append("\"packageFamilyName\":" + JsonEscape(pfn ?? name) + ",");
            sb.Append("\"sid\":" + JsonEscape(sid) + ",");
            sb.Append("\"workingDir\":" + JsonEscape(workDir) + ",");
            sb.Append("\"isExempt\":" + (isExempt ? "true" : "false"));
            sb.Append("}");
        }

        sb.Append("]");

        // 释放内存
        if (pContainers != IntPtr.Zero)
        {
            NetworkIsolationFreeAppContainers(pContainers);
        }

        return sb.ToString();
    }

    /// <summary>
    /// 设置回环豁免配置
    /// 接收 SID 字符串数组，通过 NetworkIsolationSetAppContainerConfig 设置
    /// </summary>
    public static string SetConfig(string[] sidStrings)
    {
        if (sidStrings == null || sidStrings.Length == 0)
        {
            // 清空所有豁免
            uint clearResult = NetworkIsolationSetAppContainerConfig(
                0, new SID_AND_ATTRIBUTES[0]);
            if (clearResult != 0)
            {
                return "{\"success\":false,\"error\":\"SetAppContainerConfig failed: "
                    + clearResult + "\"}";
            }
            return "{\"success\":true,\"count\":0}";
        }

        List<IntPtr> allocatedSids = new List<IntPtr>();
        try
        {
            SID_AND_ATTRIBUTES[] sids = new SID_AND_ATTRIBUTES[sidStrings.Length];
            for (int i = 0; i < sidStrings.Length; i++)
            {
                IntPtr pSid;
                if (!ConvertStringSidToSid(sidStrings[i], out pSid))
                {
                    // 释放已分配的 SID 内存
                    foreach (IntPtr p in allocatedSids) LocalFree(p);
                    return "{\"success\":false,\"error\":\"Invalid SID: "
                        + sidStrings[i] + "\"}";
                }
                allocatedSids.Add(pSid);
                sids[i].Sid = pSid;
                sids[i].Attributes = 0;
            }

            uint setResult = NetworkIsolationSetAppContainerConfig(
                (uint)sids.Length, sids);
            if (setResult != 0)
            {
                return "{\"success\":false,\"error\":\"SetAppContainerConfig failed: "
                    + setResult + "\"}";
            }

            return "{\"success\":true,\"count\":" + sids.Length + "}";
        }
        finally
        {
            // 确保释放所有分配的 SID 内存
            foreach (IntPtr p in allocatedSids) LocalFree(p);
        }
    }
}
