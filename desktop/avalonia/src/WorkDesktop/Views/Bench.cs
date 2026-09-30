using System.Diagnostics;
using System.Globalization;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Threading;
using WorkDesktop.Terminal;
using WorkDesktop.ViewModels;

namespace WorkDesktop.Views;

/// <summary>
/// For scripts/terminal-latency.ts (<c>--avalonia</c>): WORK_DESKTOP_BENCH=&lt;session id&gt; opens that
/// session, times how long until its first screen is drawn, then types keys through the view's
/// input path and records key → echo → drawn — the same span the browser measurement covers
/// (it starts at the keydown handler too). Results go to WORK_DESKTOP_BENCH_OUT, then the app exits.
/// </summary>
internal static class Bench
{
    public static async Task RunAsync(TerminalView view, MainViewModel vm, string sessionId, string outFile)
    {
        var lines = new List<string>();
        try
        {
            await vm.Started;
            var sw = Stopwatch.StartNew();
            vm.Open(sessionId);
            while (!view.HasDrawnReady && sw.ElapsedMilliseconds < 30_000) await Task.Delay(5);
            lines.Add(Format($"open {sw.Elapsed.TotalMilliseconds:0}"));
            await Task.Delay(1500);

            var probe = view.Session!.Latency;
            for (var i = 0; i < 65; i++)
            {
                if (i == 5) probe.Reset(); // warm-up
                view.SimulateInput(((char)('a' + i % 26)).ToString());
                await Task.Delay(120);
            }
            lines.Add("total " + string.Join(' ', probe.Samples().Select(x => x.ToString("0.00", CultureInfo.InvariantCulture))));
        }
        catch (Exception ex)
        {
            lines.Add("error " + ex.Message);
        }
        await File.WriteAllLinesAsync(outFile, lines);
        Dispatcher.UIThread.Post(() => (Avalonia.Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime)?.Shutdown());
    }

    private static string Format(FormattableString s) => s.ToString(CultureInfo.InvariantCulture);
}
