using MetaQuotes.MT5CommonAPI;
using MetaQuotes.MT5ManagerAPI;
using System.Text.Json;
using System.Text;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://localhost:5555");
var app = builder.Build();

// MT5 connection settings — env vars or CRM settings DB
var mt5Server = Environment.GetEnvironmentVariable("MT5_SERVER") ?? "";
var mt5Login = ulong.Parse(Environment.GetEnvironmentVariable("MT5_LOGIN") ?? "0");
var mt5Password = Environment.GetEnvironmentVariable("MT5_PASSWORD") ?? "";
var crmBackendUrl = Environment.GetEnvironmentVariable("CRM_BACKEND_URL") ?? "http://localhost:3001";

// Instantiate the deal event sink. Secret must match MT5_WEBHOOK_SECRET in Node .env.
var webhookSecret = Environment.GetEnvironmentVariable("MT5_WEBHOOK_SECRET") ?? "";
var dealSink = new DealSink(crmBackendUrl, webhookSecret);

// Load settings from CRM backend (force=true to always reload, e.g. on reconnect)
async Task LoadSettingsFromCRM(bool force = false)
{
    if (!force && !string.IsNullOrEmpty(mt5Server) && mt5Login > 0) return;
    try
    {
        using var http = new HttpClient();
        var res = await http.GetAsync($"{crmBackendUrl}/api/settings/mt5/internal");
        if (res.IsSuccessStatusCode)
        {
            var json = await res.Content.ReadFromJsonAsync<Dictionary<string, JsonElement>>();
            if (json != null)
            {
                if (json.TryGetValue("server", out var s) && s.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(s.GetString()))
                    mt5Server = s.GetString()!;
                if (json.TryGetValue("port", out var p) && p.ValueKind == JsonValueKind.String)
                {
                    // Manager API takes server as "host:port", so append port to server if separate
                    var portStr = p.GetString();
                    if (!string.IsNullOrEmpty(portStr) && !mt5Server.Contains(':'))
                        mt5Server = $"{mt5Server}:{portStr}";
                }
                if (json.TryGetValue("login", out var l) && l.ValueKind == JsonValueKind.String)
                    ulong.TryParse(l.GetString(), out mt5Login);
                if (json.TryGetValue("password", out var pw) && pw.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(pw.GetString()))
                    mt5Password = pw.GetString()!;
            }
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Could not load settings from CRM: {ex.Message}");
    }
}

await LoadSettingsFromCRM();
Console.WriteLine($"MT5 Config: server={mt5Server}, login={mt5Login}, password={(mt5Password.Length > 0 ? "****" : "(empty)")}");

// Manager API state
CIMTManagerAPI? manager = null;
var mt5Lock = new SemaphoreSlim(1, 1);
var isConnected = false;
DateTime? connectedSince = null;   // UTC timestamp of the current session's start
var initError = "";

// Manager-level sink — must be registered BEFORE per-event sinks (DealSink)
// per the MT5 SDK pattern (see SimpleDealer/Dealer.cpp). Without it, calls
// like DealSubscribe() return MT_RET_ERR_PARAMS because the underlying sink
// registration context isn't initialized.
//
// We pass action callbacks so the sink can flip `isConnected` and clear
// `connectedSince` when the broker drops us silently — without this, the
// dashboard would show "connected for 8 hours" indefinitely after a real
// disconnect, and the reconnect loop wouldn't fire.
var mgrSink = new MgrSink(
    onConnect:    () => { isConnected = true;  connectedSince = DateTime.UtcNow; },
    onDisconnect: () => { isConnected = false; connectedSince = null; }
);

// Initialize Manager API factory
try
{
    var res = SMTManagerAPIFactory.Initialize(null);
    if (res != MTRetCode.MT_RET_OK)
    {
        initError = $"Manager API factory init failed: {res}";
        Console.WriteLine(initError);
    }
    else
    {
        manager = SMTManagerAPIFactory.CreateManager(SMTManagerAPIFactory.ManagerAPIVersion, out res);
        if (res != MTRetCode.MT_RET_OK || manager == null)
        {
            initError = $"CreateManager failed: {res}";
            Console.WriteLine(initError);
        }
        else
        {
            Console.WriteLine("Manager API initialized successfully");

            // ── Register + subscribe sinks ONCE, before any Connect() ──────
            // CRITICAL: each sink must call RegisterSink() before being passed
            // to manager.Subscribe()/DealSubscribe(). RegisterSink wires up
            // the native callable wrapper (CCW) — without it, the SDK sees
            // a null native pointer and returns MT_RET_ERR_PARAMS. This is
            // the C# wrapper convention; the C++ SDK does it implicitly via
            // the vtable. Subscribes persist across reconnects, so we do
            // NOT re-do this on every reconnect.
            var mgrRegRes = mgrSink.RegisterSink();
            if (mgrRegRes != MTRetCode.MT_RET_OK)
                Console.WriteLine($"[MgrSink] RegisterSink failed: {mgrRegRes}");
            else
            {
                var mgrSubRes = manager.Subscribe(mgrSink);
                if (mgrSubRes != MTRetCode.MT_RET_OK)
                    Console.WriteLine($"[MgrSink] manager.Subscribe failed: {mgrSubRes}");
                else
                    Console.WriteLine("[MgrSink] manager-level sink subscribed");
            }

            var dealRegRes = dealSink.RegisterSink();
            if (dealRegRes != MTRetCode.MT_RET_OK)
                Console.WriteLine($"[DealSink] RegisterSink failed: {dealRegRes}");
            else
            {
                var dealSubRes = manager.DealSubscribe(dealSink);
                if (dealSubRes == MTRetCode.MT_RET_OK)
                    Console.WriteLine("[DealSink] Subscribed to MT5 deal events — real-time webhook active");
                else
                    Console.WriteLine($"[DealSink] Subscribe failed: {dealSubRes} — falling back to hourly sweep only");
            }
        }
    }
}
catch (Exception ex)
{
    initError = $"Manager API init exception: {ex.Message}";
    Console.WriteLine(initError);
}

// Connect to MT5
bool ConnectToMT5()
{
    if (manager == null) return false;
    if (string.IsNullOrEmpty(mt5Server) || mt5Login == 0) return false;

    var res = manager.Connect(mt5Server, mt5Login, mt5Password, null,
        CIMTManagerAPI.EnPumpModes.PUMP_MODE_FULL, 30000);
    if (res == MTRetCode.MT_RET_OK)
    {
        isConnected = true;
        connectedSince = DateTime.UtcNow;
        Console.WriteLine($"Connected to MT5: {mt5Server} as login {mt5Login}");
        // Sinks (mgrSink, dealSink) were registered ONCE at startup before
        // the first Connect — they persist across reconnects, so nothing
        // else to do here.
        return true;
    }
    else
    {
        Console.WriteLine($"MT5 connection failed: {res}");
        return false;
    }
}

void EnsureConnected()
{
    if (manager != null && !isConnected)
        ConnectToMT5();
    if (!isConnected)
        throw new Exception(string.IsNullOrEmpty(initError) ? "Not connected to MT5" : initError);
}

// Auto-connect on startup if settings are available
ConnectToMT5();

// ── Background reconnect loop ─────────────────────────────────────────────
// MT5 manager sessions can drop for many reasons — broker-side maintenance,
// network blip, idle timeout, server restart. Without this loop, isConnected
// flips false and stays false until someone manually POSTs /connect.
//
// Every 30s, if disconnected, try to re-establish. mt5Lock serializes against
// concurrent /connect calls so we don't double-Connect.
//
// Cancellation: tied to the app lifetime — when the host shuts down,
// stoppingToken cancels and the loop exits cleanly.
_ = Task.Run(async () =>
{
    while (true)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(30)); } catch { return; }

        // Skip if connected, manager not initialized, or we don't yet have credentials
        if (manager == null || isConnected) continue;
        if (string.IsNullOrEmpty(mt5Server) || mt5Login == 0) continue;

        // Coordinate with /connect and /reconnect handlers — they hold mt5Lock
        if (!await mt5Lock.WaitAsync(TimeSpan.FromSeconds(2))) continue;
        try
        {
            // Re-check inside the lock — another path might have reconnected
            if (isConnected) continue;
            Console.WriteLine($"[Reconnect] attempting to re-establish manager session ({mt5Server} as {mt5Login})...");
            var ok = ConnectToMT5();
            if (ok) Console.WriteLine("[Reconnect] success");
            // On failure, ConnectToMT5() already logs the MT5RetCode
        }
        finally
        {
            mt5Lock.Release();
        }
    }
});

// ---- ENDPOINTS ----

app.MapGet("/health", () => Results.Ok(new {
    status        = "ok",
    mt5Connected  = isConnected,
    // ISO 8601 UTC timestamp of when the current MT5 session was established.
    // Cleared when the bridge disconnects (manual or via OnDisconnect callback)
    // so admins can spot silent intra-day flaps from the dashboard.
    connectedSince = connectedSince?.ToString("o"),
    initError      = string.IsNullOrEmpty(initError) ? null : initError,
}));

app.MapPost("/connect", async () =>
{
    await mt5Lock.WaitAsync();
    try
    {
        if (manager != null && isConnected) manager.Disconnect();
        isConnected = false;
        connectedSince = null;
        await LoadSettingsFromCRM(force: true);

        if (manager == null)
            return Results.Ok(new { success = false, error = initError });

        var res = manager.Connect(mt5Server, mt5Login, mt5Password, null,
            CIMTManagerAPI.EnPumpModes.PUMP_MODE_FULL, 30000);
        if (res == MTRetCode.MT_RET_OK)
        {
            isConnected = true;
            connectedSince = DateTime.UtcNow;
            // Sinks were registered once at startup before the first Connect;
            // they persist across reconnects.
            return Results.Ok(new { success = true, message = $"Connected to {mt5Server} as login {mt5Login}" });
        }
        return Results.Ok(new { success = false, error = $"Connection failed: {res}", server = mt5Server, login = mt5Login });
    }
    finally
    {
        mt5Lock.Release();
    }
});

app.MapPost("/reconnect", async () =>
{
    await mt5Lock.WaitAsync();
    try
    {
        if (manager != null && isConnected) manager.Disconnect();
        isConnected = false;
        connectedSince = null;
        await LoadSettingsFromCRM(force: true);
        return Results.Ok(new { status = "disconnected", message = "Ready to reconnect" });
    }
    finally
    {
        mt5Lock.Release();
    }
});

// GET /accounts/{login} — account balance, equity, margin etc.
// Source: MT5 Manager API — UserAccountRequest
app.MapGet("/accounts/{login}", async (ulong login) =>
{
    await mt5Lock.WaitAsync();
    try
    {
        EnsureConnected();
        var account = manager!.UserCreateAccount();
        var user = manager.UserCreate();
        if (account == null || user == null)
            return Results.Json(new { error = "Failed to create account/user objects" }, statusCode: 500);

        var res = manager.UserAccountRequest(login, account);
        if (res != MTRetCode.MT_RET_OK)
            return Results.Json(new { error = $"UserAccountRequest failed: {res}" }, statusCode: 404);

        // Also get user info for name, group, leverage
        manager.UserRequest(login, user);

        var result = new
        {
            login = login,
            name = user.Name(),
            group = user.Group(),
            balance = account.Balance(),
            equity = account.Equity(),
            margin = account.Margin(),
            marginFree = account.MarginFree(),
            marginLevel = account.MarginLevel(),
            profit = account.Profit(),
            credit = account.Credit(),
            marginLeverage = user.Leverage(),
            registration = user.Registration(),
            lastAccess = user.LastAccess(),
        };

        account.Dispose();
        user.Dispose();
        return Results.Json(result);
    }
    catch (Exception ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: 500);
    }
    finally
    {
        mt5Lock.Release();
    }
});

// GET /transactions/{login} — deposit & withdrawal history
// Source: MT5 Manager API — DealRequest
app.MapGet("/transactions/{login}", async (ulong login, string? from, string? to) =>
{
    await mt5Lock.WaitAsync();
    try
    {
        EnsureConnected();
        var dealArray = manager!.DealCreateArray();
        if (dealArray == null)
            return Results.Json(new { error = "Failed to create deal array" }, statusCode: 500);

        var fromTime = SMTTime.FromDateTime(
            !string.IsNullOrEmpty(from) ? DateTime.Parse(from).ToUniversalTime() : DateTime.UtcNow.AddMonths(-1));
        var toTime = SMTTime.FromDateTime(
            !string.IsNullOrEmpty(to) ? DateTime.Parse(to).ToUniversalTime() : DateTime.UtcNow);

        var res = manager.DealRequest(login, fromTime, toTime, dealArray);
        if (res != MTRetCode.MT_RET_OK)
        {
            dealArray.Dispose();
            return Results.Json(new { error = $"DealRequest failed: {res}" }, statusCode: 404);
        }

        var transactions = new List<object>();
        double totalDeposits = 0, totalWithdrawals = 0;

        for (uint i = 0; i < dealArray.Total(); i++)
        {
            var deal = dealArray.Next(i);
            if (deal == null) continue;

            var action = deal.Action();
            // Filter for balance operations (deposits/withdrawals)
            if (action == (uint)CIMTDeal.EnDealAction.DEAL_BALANCE ||
                action == (uint)CIMTDeal.EnDealAction.DEAL_CREDIT)
            {
                var profit = deal.Profit();
                var isDeposit = profit >= 0;

                if (isDeposit) totalDeposits += profit;
                else totalWithdrawals += Math.Abs(profit);

                transactions.Add(new
                {
                    time = deal.Time(),
                    type = isDeposit ? "deposit" : "withdrawal",
                    amount = Math.Abs(profit),
                    comment = deal.Comment(),
                    dealId = deal.Deal(),
                });
            }
        }

        dealArray.Dispose();
        return Results.Json(new
        {
            login,
            transactions,
            totalDeposits,
            totalWithdrawals,
            count = transactions.Count,
        });
    }
    catch (Exception ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: 500);
    }
    finally
    {
        mt5Lock.Release();
    }
});

// GET /history/{login} — closed trade history (buy/sell deals only, no balance operations)
// Source: MT5 Manager API — DealRequest
app.MapGet("/history/{login}", async (ulong login, string? from, string? to) =>
{
    await mt5Lock.WaitAsync();
    try
    {
        EnsureConnected();
        var dealArray = manager!.DealCreateArray();
        if (dealArray == null)
            return Results.Json(new { error = "Failed to create deal array" }, statusCode: 500);

        var fromTime = SMTTime.FromDateTime(
            !string.IsNullOrEmpty(from) ? DateTime.Parse(from).ToUniversalTime() : DateTime.UtcNow.AddMonths(-1));
        var toTime = SMTTime.FromDateTime(
            !string.IsNullOrEmpty(to) ? DateTime.Parse(to).ToUniversalTime() : DateTime.UtcNow);

        var res = manager.DealRequest(login, fromTime, toTime, dealArray);
        if (res != MTRetCode.MT_RET_OK)
        {
            dealArray.Dispose();
            return Results.Json(new { error = $"DealRequest failed: {res}" }, statusCode: 404);
        }

        var trades = new List<object>();
        double totalProfit = 0;

        for (uint i = 0; i < dealArray.Total(); i++)
        {
            var deal = dealArray.Next(i);
            if (deal == null) continue;

            var action = deal.Action();
            // Only include buy/sell deals (0=Buy, 1=Sell), skip balance/credit/corrections
            if (action == (uint)CIMTDeal.EnDealAction.DEAL_BUY ||
                action == (uint)CIMTDeal.EnDealAction.DEAL_SELL)
            {
                var profit = deal.Profit() + deal.Storage() + deal.Commission();
                totalProfit += profit;

                trades.Add(new
                {
                    dealId = deal.Deal(),
                    time = deal.Time(),
                    symbol = deal.Symbol(),
                    action = action == (uint)CIMTDeal.EnDealAction.DEAL_BUY ? "Buy" : "Sell",
                    volume = deal.Volume(),
                    price = deal.Price(),
                    profit = deal.Profit(),
                    swap = deal.Storage(),
                    commission = deal.Commission(),
                    comment = deal.Comment(),
                    entry = deal.Entry(), // 0=In, 1=Out, 2=InOut
                });
            }
        }

        dealArray.Dispose();
        return Results.Json(new
        {
            login,
            trades,
            totalProfit,
            count = trades.Count,
        });
    }
    catch (Exception ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: 500);
    }
    finally
    {
        mt5Lock.Release();
    }
});

// GET /positions/{login} — open positions
// Source: MT5 Manager API — PositionGet
app.MapGet("/positions/{login}", async (ulong login) =>
{
    await mt5Lock.WaitAsync();
    try
    {
        EnsureConnected();
        var posArray = manager!.PositionCreateArray();
        if (posArray == null)
            return Results.Json(new { error = "Failed to create position array" }, statusCode: 500);

        var res = manager.PositionGet(login, posArray);
        if (res != MTRetCode.MT_RET_OK)
        {
            posArray.Dispose();
            // No positions is not an error
            return Results.Json(new { login, positions = Array.Empty<object>(), total = 0 });
        }

        var positions = new List<object>();
        for (uint i = 0; i < posArray.Total(); i++)
        {
            var pos = posArray.Next(i);
            if (pos == null) continue;

            positions.Add(new
            {
                symbol = pos.Symbol(),
                action = (int)pos.Action(),
                actionName = pos.Action() == 0 ? "Buy" : "Sell",
                volume = pos.Volume(),
                priceOpen = pos.PriceOpen(),
                priceCurrent = pos.PriceCurrent(),
                profit = pos.Profit(),
                swap = pos.Storage(),
                time = pos.TimeCreate(),
            });
        }

        posArray.Dispose();
        return Results.Json(new
        {
            login,
            positions,
            total = positions.Count,
        });
    }
    catch (Exception ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: 500);
    }
    finally
    {
        mt5Lock.Release();
    }
});

app.Run();

// ── MgrSink ──────────────────────────────────────────────────────────────────
// Manager-level event sink. Required by the MT5 SDK as the FIRST subscription
// before any per-event subscribe (DealSubscribe, OrderSubscribe, etc.). Without
// it those calls return MT_RET_ERR_PARAMS because the registration context
// hasn't been set up. We don't act on the manager-level events here — just
// log them for visibility — but the registration itself is what matters.
class MgrSink : CIMTManagerSink
{
    private readonly Action _onConnect;
    private readonly Action _onDisconnect;

    public MgrSink(Action? onConnect = null, Action? onDisconnect = null)
    {
        _onConnect    = onConnect    ?? (() => {});
        _onDisconnect = onDisconnect ?? (() => {});
    }

    public override void OnConnect()
    {
        _onConnect();
        Console.WriteLine("[MgrSink] OnConnect — manager session established");
    }
    public override void OnDisconnect()
    {
        _onDisconnect();
        Console.WriteLine("[MgrSink] OnDisconnect — manager session lost");
    }
}

// ── DealSink ─────────────────────────────────────────────────────────────────
// Extends CIMTDealSink (MetaQuotes.MT5CommonAPI) so the MT5 pump thread calls
// OnDealAdd() for every deal the server executes (any account, any symbol).
// Registered with manager.DealSubscribe() after each successful Connect().
//
// We copy all CIMTDeal fields synchronously — the pointer is only valid during
// the callback — then fire-and-forget an HTTP POST to the Node backend.
// The backend ACKs immediately and processes asynchronously, so the pump
// thread is never blocked for more than a few microseconds.
//
// Authentication: shared secret in X-MT5-Webhook-Secret header. Set it in
// the .env file as MT5_WEBHOOK_SECRET (same value on both sides).
class DealSink : CIMTDealSink
{
    private readonly HttpClient _http;
    private readonly string _webhookUrl;
    private readonly string _secret;

    public DealSink(string backendUrl, string secret)
    {
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        _webhookUrl = $"{backendUrl}/api/mt5/webhook/deal";
        _secret = secret;
    }

    public override void OnDealAdd(CIMTDeal deal)
    {
        ForwardDeal(deal, "add");
    }

    /// <summary>
    /// Fires when a manager edits an existing deal — most commonly to correct
    /// a commission or swap charge. Without this handler, the portal's cache
    /// keeps the original (wrong) values and the commission engine over-/under-
    /// pays agents. Forwarding the same payload with op=update tells the
    /// portal to upsert the mutable fields (commission, profit, comment).
    /// </summary>
    public override void OnDealUpdate(CIMTDeal deal)
    {
        ForwardDeal(deal, "update");
    }

    /// <summary>
    /// Fires when a deal is deleted server-side (rare; usually post-trade
    /// correction). We forward it as op=delete so the portal can DELETE the
    /// row from mt5_deal_cache. Skipping this would leave a phantom deal
    /// influencing commission totals.
    /// </summary>
    public override void OnDealDelete(CIMTDeal deal)
    {
        ForwardDeal(deal, "delete");
    }

    private void ForwardDeal(CIMTDeal deal, string op)
    {
        if (deal == null) return;

        // ── IMPORTANT: copy all fields synchronously ──────────────────────
        // The CIMTDeal object is owned by the MT5 Manager API and may be
        // reused or freed as soon as this callback returns. Do NOT capture
        // the deal pointer in the async lambda — read everything here.
        var dealId     = deal.Deal();
        var login      = deal.Login();
        var time       = (ulong)deal.Time(); // Unix timestamp (seconds)
        var symbol     = deal.Symbol();
        var action     = (uint)deal.Action();
        var entry      = (uint)deal.Entry();
        var volume     = deal.Volume();
        var price      = deal.Price();
        var commission = deal.Commission();
        var profit     = deal.Profit();
        var comment    = deal.Comment();

        // Fire-and-forget — never block the MT5 pump thread
        _ = PostAsync(op, dealId, login, time, symbol, action, entry, volume, price, commission, profit, comment);
    }

    private async Task PostAsync(
        string op,
        ulong dealId, ulong login, ulong time, string symbol,
        uint action, uint entry, ulong volume,
        double price, double commission, double profit, string comment)
    {
        try
        {
            var payload = new
            {
                op,                                  // "add" | "update" | "delete"
                dealId, login, time, symbol, action, entry,
                volume, price, commission, profit, comment,
            };
            var json    = JsonSerializer.Serialize(payload);
            var content = new StringContent(json, Encoding.UTF8, "application/json");
            content.Headers.Add("X-MT5-Webhook-Secret", _secret);
            var response = await _http.PostAsync(_webhookUrl, content);
            if (!response.IsSuccessStatusCode)
                Console.WriteLine($"[DealSink] webhook returned {(int)response.StatusCode}");
        }
        catch (Exception ex)
        {
            // Non-fatal — the hourly sweep will catch any missed deals
            Console.WriteLine($"[DealSink] webhook POST failed: {ex.Message}");
        }
    }
}
