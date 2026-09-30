using Avalonia.Controls;
using WorkDesktop.ViewModels;

namespace WorkDesktop.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Term.LatencyUpdated += () => (DataContext as MainViewModel)?.UpdateLatency();
        // Picking a session puts the keyboard in its terminal, as the browser's Terminal tab does.
        Term.PropertyChanged += (_, e) =>
        {
            if (e.Property == Terminal.TerminalView.SessionProperty && e.NewValue != null) Term.Focus();
        };
        Opened += (_, _) =>
        {
            if (Environment.GetEnvironmentVariable("WORK_DESKTOP_BENCH") is { Length: > 0 } id
                && Environment.GetEnvironmentVariable("WORK_DESKTOP_BENCH_OUT") is { Length: > 0 } outFile
                && DataContext is MainViewModel vm)
                _ = Bench.RunAsync(Term, vm, id, outFile);
            else if (Environment.GetEnvironmentVariable("WORK_DESKTOP_OPEN") is { Length: > 0 } open && DataContext is MainViewModel vm2)
                _ = vm2.Started.ContinueWith(_ => Avalonia.Threading.Dispatcher.UIThread.Post(() => vm2.Open(open)), TaskScheduler.Default);
        };
    }
}
