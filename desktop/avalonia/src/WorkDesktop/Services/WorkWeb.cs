using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;

namespace WorkDesktop.Services;

public sealed record SessionInfo(string Id, string Target, string Branch, string Status, DateTimeOffset LastActive);

/// <summary>
/// The running `work web`: found through ~/.work/web.url (checked with GET /api/context, as the CLI
/// does), started in the background (`work web --no-open`) when there is none. WORK_DESKTOP_URL
/// points at a specific server instead.
/// </summary>
public sealed class WorkWeb
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };

    public Uri Base { get; }

    private WorkWeb(Uri baseUri) => Base = baseUri;

    public static async Task<WorkWeb> FindOrStartAsync(Action<string> status)
    {
        if (Environment.GetEnvironmentVariable("WORK_DESKTOP_URL") is { Length: > 0 } fixedUrl)
            return new WorkWeb(new Uri(fixedUrl));
        if (RecordedUrl() is { } url && await RespondsAsync(url)) return new WorkWeb(url);

        status("Starting work web…");
        Process.Start(new ProcessStartInfo("cmd.exe")
        {
            // Constant argv: nothing user-supplied reaches the shell.
            ArgumentList = { "/C", "work", "web", "--no-open" },
            CreateNoWindow = true,
            UseShellExecute = false,
        });
        var deadline = DateTime.UtcNow.AddSeconds(25);
        while (DateTime.UtcNow < deadline)
        {
            await Task.Delay(250);
            if (RecordedUrl() is { } started && await RespondsAsync(started)) return new WorkWeb(started);
        }
        throw new InvalidOperationException("work web did not come up within 25 s. Run `work web` in a terminal to see why.");
    }

    private static Uri? RecordedUrl()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var file = Path.Combine(home, ".work", "web.url");
        if (!File.Exists(file)) return null;
        var text = File.ReadAllText(file).Trim();
        return Uri.TryCreate(text, UriKind.Absolute, out var u) ? u : null;
    }

    private static async Task<bool> RespondsAsync(Uri url)
    {
        try
        {
            using var r = await Http.GetAsync(new Uri(url, "api/context"));
            return r.IsSuccessStatusCode;
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) { return false; }
    }

    /// <summary>Live sessions, most recently active first (the rows of GET /api/sessions).</summary>
    public async Task<IReadOnlyList<SessionInfo>> SessionsAsync()
    {
        await using var body = await Http.GetStreamAsync(new Uri(Base, "api/sessions"));
        using var doc = await JsonDocument.ParseAsync(body);
        var list = new List<SessionInfo>();
        foreach (var s in doc.RootElement.GetProperty("sessions").EnumerateArray())
        {
            if (s.TryGetProperty("archivedAt", out var a) && a.ValueKind == JsonValueKind.String) continue;
            var status = s.TryGetProperty("attention", out var att) && att.ValueKind == JsonValueKind.Object && att.TryGetProperty("state", out var st)
                ? st.GetString() ?? ""
                : s.TryGetProperty("activityState", out var act) ? act.GetString() ?? "" : "";
            var last = s.TryGetProperty("lastActivity", out var la) && la.ValueKind == JsonValueKind.Number
                ? DateTimeOffset.FromUnixTimeMilliseconds((long)la.GetDouble())
                : DateTimeOffset.TryParse(s.GetProperty("lastAccessedAt").GetString(), out var acc) ? acc : DateTimeOffset.MinValue;
            list.Add(new SessionInfo(s.GetProperty("id").GetString()!, s.GetProperty("target").GetString()!, s.GetProperty("branch").GetString()!, status, last));
        }
        return list.OrderByDescending(x => x.LastActive).ToList();
    }
}
