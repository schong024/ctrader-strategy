// src/main.js
// cTrader Price Move + Stochastic Plugin
// Phase 1: Connect to cTrader Desktop, load account,
// find XAUUSD and receive live Bid/Ask quotes.
//
// IMPORTANT:
// Automated order execution is intentionally NOT enabled yet.
// First confirm connection, symbol and live pricing are correct.

import {
    createClientAdapter
} from "@spotware-web-team/sdk-external-api";

import {
    getAccountInformation,
    getLightSymbolList,
    getSymbol,
    handleConfirmEvent,
    quoteEvent,
    registerEvent,
    subscribeQuotes,
    unsubscribeQuotes
} from "@spotware-web-team/sdk";

import {
    catchError,
    of,
    take,
    tap
} from "rxjs";

import {
    createLogger
} from "@veksa/logger";


/* ============================================================
   STRATEGY SETTINGS
   ============================================================ */

const CONFIG = {

    symbolName: "XAUUSD",

    // Price must move this amount from reference price
    requiredMove: 10.0,

    // Strategy parameters
    takeProfit: 7.0,
    stopLoss: 7.0,

    lotSize: 0.01,
    maximumPositions: 1,

    // Stochastic 5,3,3
    stochasticKPeriod: 5,
    stochasticDPeriod: 3,
    stochasticSlowing: 3,

    // Singapore trading period
    singaporeStartHour: 20,
    singaporeEndHour: 0
};


/* ============================================================
   RUNTIME STATE
   ============================================================ */

const state = {

    connected: false,

    quotesSubscribed: false,

    strategyRunning: false,

    accountId: null,

    symbolId: null,

    symbol: null,

    symbolDigits: 2,

    bid: null,

    ask: null,

    referencePrice: null,

    priceMovement: null,

    stochasticK: null,

    quoteSubscription: null
};


/* ============================================================
   HTML ELEMENT LOOKUP
   ============================================================ */

function getElement(...ids) {

    for (const id of ids) {

        const element =
            document.getElementById(id);

        if (element) {

            return element;
        }
    }

    return null;
}


const ui = {

    connection: getElement(
        "ui-connection",
        "host-connection",
        "connection-status"
    ),

    account: getElement(
        "ui-account",
        "account",
        "account-id"
    ),

    symbol: getElement(
        "ui-symbol",
        "target-symbol",
        "symbol-name"
    ),

    symbolId: getElement(
        "ui-symbol-id",
        "symbol-id"
    ),

    bid: getElement(
        "ui-bid",
        "current-bid",
        "bid"
    ),

    ask: getElement(
        "ui-ask",
        "current-ask",
        "ask"
    ),

    reference: getElement(
        "ui-ref",
        "ui-reference",
        "reference-price"
    ),

    movement: getElement(
        "ui-movement",
        "price-movement"
    ),

    stochastic: getElement(
        "ui-stoch",
        "current-stoch",
        "stochastic-k"
    ),

    tradingWindow: getElement(
        "ui-trading-window",
        "trading-window"
    ),

    position: getElement(
        "ui-position",
        "position-status"
    ),

    strategyStatus: getElement(
        "ui-strategy-status",
        "strategy-status"
    ),

    startButton: getElement(
        "startBtn",
        "start-btn",
        "start-strategy"
    ),

    stopButton: getElement(
        "stopBtn",
        "stop-btn",
        "stop-strategy"
    ),

    resetButton: getElement(
        "resetBtn",
        "reset-btn",
        "reset-reference"
    ),

    log: getElement(
        "log",
        "log-box",
        "system-log"
    )
};


/* ============================================================
   UI FUNCTIONS
   ============================================================ */

function setText(element, value) {

    if (element) {

        element.textContent = value;
    }
}


function setColour(element, colour) {

    if (element) {

        element.style.color = colour;
    }
}


function setButtonState(
    element,
    disabled,
    text = null
) {

    if (!element) {

        return;
    }

    element.disabled = disabled;

    if (text !== null) {

        element.textContent = text;
    }
}


/* ============================================================
   LOGGING
   ============================================================ */

function logMessage(
    message,
    type = "normal"
) {

    const time =
        new Date().toLocaleTimeString(
            "en-SG",
            {
                hour12: false
            }
        );

    const completeMessage =
        `[${time}] ${message}`;

    console.log(completeMessage);

    if (!ui.log) {

        return;
    }

    const row =
        document.createElement("div");

    row.className =
        "log-entry";

    row.textContent =
        completeMessage;

    if (type === "success") {

        row.style.color =
            "#30d158";

    } else if (
        type === "warning"
    ) {

        row.style.color =
            "#ffd60a";

    } else if (
        type === "error"
    ) {

        row.style.color =
            "#ff453a";
    }

    ui.log.appendChild(row);

    ui.log.scrollTop =
        ui.log.scrollHeight;
}


function formatError(error) {

    if (
        error === null ||
        error === undefined
    ) {

        return "Unknown error";
    }

    if (
        typeof error === "string"
    ) {

        return error;
    }

    if (error.message) {

        return error.message;
    }

    try {

        return JSON.stringify(error);

    } catch {

        return String(error);
    }
}


/* ============================================================
   INITIAL DISPLAY
   ============================================================ */

function initialiseDisplay() {

    setText(
        ui.connection,
        "Connecting..."
    );

    setColour(
        ui.connection,
        "#ffd60a"
    );

    setText(
        ui.account,
        "--"
    );

    setText(
        ui.symbol,
        CONFIG.symbolName
    );

    setText(
        ui.symbolId,
        "--"
    );

    setText(
        ui.bid,
        "--"
    );

    setText(
        ui.ask,
        "--"
    );

    setText(
        ui.reference,
        "--"
    );

    setText(
        ui.movement,
        "--"
    );

    setText(
        ui.stochastic,
        "--"
    );

    setText(
        ui.tradingWindow,
        getTradingWindowStatus()
    );

    setText(
        ui.position,
        "--"
    );

    setText(
        ui.strategyStatus,
        "Stopped"
    );

    setButtonState(
        ui.startButton,
        true,
        "Connecting to cTrader..."
    );

    setButtonState(
        ui.stopButton,
        true,
        "Stop Automated Strategy"
    );

    setButtonState(
        ui.resetButton,
        true,
        "Reset Reference Price"
    );
}


/* ============================================================
   SINGAPORE TRADING WINDOW
   ============================================================ */

function getSingaporeHour() {

    const parts =
        new Intl.DateTimeFormat(
            "en-SG",
            {
                timeZone:
                    "Asia/Singapore",

                hour:
                    "2-digit",

                hourCycle:
                    "h23"
            }
        ).formatToParts(
            new Date()
        );

    const hourPart =
        parts.find(
            (part) =>
                part.type === "hour"
        );

    if (hourPart) {

        return Number(
            hourPart.value
        );
    }

    return (
        new Date().getUTCHours() +
        8
    ) % 24;
}


function isSingaporeTradingWindowOpen() {

    const hour =
        getSingaporeHour();

    return (
        hour >=
        CONFIG.singaporeStartHour
        &&
        hour < 24
    );
}


function getTradingWindowStatus() {

    if (
        isSingaporeTradingWindowOpen()
    ) {

        return "OPEN";
    }

    return "CLOSED";
}


function updateTradingWindowDisplay() {

    const status =
        getTradingWindowStatus();

    setText(
        ui.tradingWindow,
        status
    );

    if (
        status === "OPEN"
    ) {

        setColour(
            ui.tradingWindow,
            "#30d158"
        );

    } else {

        setColour(
            ui.tradingWindow,
            "#ff9f0a"
        );
    }
}


/* ============================================================
   CREATE CTRADER ADAPTER
   ============================================================ */

const logger =
    createLogger(true);


const adapter =
    createClientAdapter({
        logger
    });


/* ============================================================
   CONNECT TO CTRADER
   ============================================================ */

function connectToCTrader() {

    logMessage(
        "Initialising cTrader Plugin SDK..."
    );

    /*
        Initial confirmation
    */

    handleConfirmEvent(
        adapter,
        {}
    )
        .pipe(

            take(1),

            tap(() => {

                logMessage(
                    "Initial adapter confirmation received."
                );
            }),

            catchError(
                (error) => {

                    logMessage(
                        "Initial confirmation error: " +
                        formatError(error),
                        "error"
                    );

                    return of(null);
                }
            )
        )
        .subscribe();


    logMessage(
        "Registering plugin with cTrader host..."
    );


    /*
        Register plugin with cTrader
    */

    registerEvent(
        adapter
    )
        .pipe(

            take(1),

            tap((result) => {

                console.log(
                    "registerEvent response:",
                    result
                );


                /*
                    Confirm registration
                */

                handleConfirmEvent(
                    adapter,
                    {}
                )
                    .pipe(

                        take(1),

                        catchError(
                            (error) => {

                                logMessage(
                                    "Registration confirmation error: " +
                                    formatError(error),
                                    "error"
                                );

                                return of(null);
                            }
                        )
                    )
                    .subscribe();


                state.connected =
                    true;


                setText(
                    ui.connection,
                    "Connected"
                );


                setColour(
                    ui.connection,
                    "#30d158"
                );


                logMessage(
                    "Connected to cTrader Desktop.",
                    "success"
                );


                loadAccountInformation();

                loadSymbolList();
            }),


            catchError(
                (error) => {

                    state.connected =
                        false;


                    setText(
                        ui.connection,
                        "Connection failed"
                    );


                    setColour(
                        ui.connection,
                        "#ff453a"
                    );


                    setButtonState(
                        ui.startButton,
                        true,
                        "cTrader Connection Failed"
                    );


                    logMessage(
                        "Host registration failed: " +
                        formatError(error),
                        "error"
                    );


                    return of(null);
                }
            )
        )
        .subscribe();
}


/* ============================================================
   ACCOUNT INFORMATION
   ============================================================ */

function loadAccountInformation() {

    if (
        !state.connected
    ) {

        return;
    }


    logMessage(
        "Requesting account information..."
    );


    getAccountInformation(
        adapter,
        {}
    )
        .pipe(

            take(1),

            tap((result) => {

                console.log(
                    "getAccountInformation response:",
                    result
                );


                const account =
                    result?.account ??
                    result?.payload?.account ??
                    result?.accountInformation ??
                    result?.payload?.accountInformation ??
                    result;


                const accountId =
                    account?.accountId ??
                    account?.ctidTraderAccountId ??
                    account?.login ??
                    account?.id ??
                    "--";


                state.accountId =
                    accountId;


                setText(
                    ui.account,
                    String(accountId)
                );


                logMessage(
                    `Account loaded: ${accountId}`,
                    "success"
                );
            }),


            catchError(
                (error) => {

                    setText(
                        ui.account,
                        "Unavailable"
                    );


                    logMessage(
                        "Account information error: " +
                        formatError(error),
                        "warning"
                    );


                    return of(null);
                }
            )
        )
        .subscribe();
}


/* ============================================================
   FIND XAUUSD
   ============================================================ */

function loadSymbolList() {

    if (
        !state.connected
    ) {

        return;
    }


    logMessage(
        `Searching for ${CONFIG.symbolName}...`
    );


    getLightSymbolList(
        adapter,
        {
            includeArchivedSymbols:
                false
        }
    )
        .pipe(

            take(1),

            tap((result) => {

                console.log(
                    "getLightSymbolList response:",
                    result
                );


                const symbols =
                    extractArray(
                        result,
                        [
                            "symbol",
                            "symbols",
                            "lightSymbol",
                            "lightSymbols"
                        ]
                    );


                if (
                    !symbols.length
                ) {

                    logMessage(
                        "No recognised symbol array was returned. Check the console response.",
                        "error"
                    );

                    return;
                }


                const target =
                    CONFIG.symbolName
                        .toUpperCase();


                /*
                    Exact match first
                */

                let selectedSymbol =
                    symbols.find(
                        (symbol) => {

                            return (
                                getSymbolName(
                                    symbol
                                )
                                === target
                            );
                        }
                    );


                /*
                    Broker suffix fallback

                    Examples:
                    XAUUSD.c
                    XAUUSDm
                    XAUUSD-STD
                */

                if (
                    !selectedSymbol
                ) {

                    selectedSymbol =
                        symbols.find(
                            (symbol) => {

                                return (
                                    getSymbolName(
                                        symbol
                                    )
                                    .startsWith(
                                        target
                                    )
                                );
                            }
                        );
                }


                if (
                    !selectedSymbol
                ) {

                    const candidates =
                        symbols
                            .filter(
                                (symbol) => {

                                    const name =
                                        getSymbolName(
                                            symbol
                                        );

                                    return (
                                        name.includes(
                                            "XAU"
                                        )
                                        ||
                                        name.includes(
                                            "GOLD"
                                        )
                                    );
                                }
                            )
                            .map(
                                getSymbolName
                            );


                    logMessage(
                        `${CONFIG.symbolName} not found. Gold candidates: ${
                            candidates.join(", ") ||
                            "none"
                        }`,
                        "error"
                    );


                    return;
                }


                state.symbolId =
                    selectedSymbol.symbolId ??
                    selectedSymbol.id ??
                    selectedSymbol
                        ?.symbol
                        ?.symbolId;


                if (
                    state.symbolId ===
                        null
                    ||
                    state.symbolId ===
                        undefined
                ) {

                    logMessage(
                        "XAUUSD was found but no symbol ID was returned.",
                        "error"
                    );


                    console.log(
                        "Selected symbol:",
                        selectedSymbol
                    );


                    return;
                }


                const actualName =
                    getSymbolName(
                        selectedSymbol
                    );


                setText(
                    ui.symbol,
                    actualName
                );


                setText(
                    ui.symbolId,
                    String(
                        state.symbolId
                    )
                );


                logMessage(
                    `${actualName} found. Symbol ID: ${state.symbolId}`,
                    "success"
                );


                loadDetailedSymbol();
            }),


            catchError(
                (error) => {

                    logMessage(
                        "Symbol-list request failed: " +
                        formatError(error),
                        "error"
                    );


                    return of(null);
                }
            )
        )
        .subscribe();
}


/* ============================================================
   RESPONSE HELPERS
   ============================================================ */

function extractArray(
    result,
    possibleKeys
) {

    if (
        !result
    ) {

        return [];
    }


    for (
        const key
        of possibleKeys
    ) {

        if (
            Array.isArray(
                result[key]
            )
        ) {

            return result[key];
        }


        if (
            Array.isArray(
                result?.payload?.[key]
            )
        ) {

            return result
                .payload[key];
        }
    }


    return [];
}


function getSymbolName(
    symbol
) {

    return String(

        symbol?.symbolName ??
        symbol?.name ??
        symbol?.symbol ??
        symbol?.ticker ??
        ""

    ).toUpperCase();
}


/* ============================================================
   LOAD SYMBOL DETAILS
   ============================================================ */

function loadDetailedSymbol() {

    logMessage(
        "Requesting detailed symbol information..."
    );


    getSymbol(
        adapter,
        {
            symbolId: [
                Number(
                    state.symbolId
                )
            ]
        }
    )
        .pipe(

            take(1),

            tap((result) => {

                console.log(
                    "getSymbol response:",
                    result
                );


                const symbols =
                    extractArray(
                        result,
                        [
                            "symbol",
                            "symbols"
                        ]
                    );


                state.symbol =
                    symbols[0] ??
                    result?.symbol ??
                    result
                        ?.payload
                        ?.symbol ??
                    null;


                const digits =
                    state.symbol
                        ?.digits ??
                    state.symbol
                        ?.precision;


                if (
                    Number.isFinite(
                        Number(
                            digits
                        )
                    )
                ) {

                    state.symbolDigits =
                        Number(
                            digits
                        );
                }


                logMessage(
                    `Symbol details loaded. Price digits: ${state.symbolDigits}`,
                    "success"
                );


                subscribeToQuotes();
            }),


            catchError(
                (error) => {

                    logMessage(
                        "Detailed symbol request failed: " +
                        formatError(error) +
                        ". Attempting quote subscription anyway.",
                        "warning"
                    );


                    subscribeToQuotes();


                    return of(null);
                }
            )
        )
        .subscribe();
}


/* ============================================================
   SUBSCRIBE TO LIVE XAUUSD QUOTES
   ============================================================ */

function subscribeToQuotes() {

    if (
        !state.connected
    ) {

        logMessage(
            "Cannot subscribe because cTrader is not connected.",
            "error"
        );

        return;
    }


    if (
        state.symbolId ===
            null
        ||
        state.symbolId ===
            undefined
    ) {

        logMessage(
            "Cannot subscribe because the symbol ID is unavailable.",
            "error"
        );

        return;
    }


    /*
        Start listening for quote events
    */

    if (
        !state.quoteSubscription
    ) {

        state.quoteSubscription =
            quoteEvent(
                adapter
            )
                .pipe(

                    tap((result) => {

                        processQuote(
                            result
                        );
                    }),

                    catchError(
                        (error) => {

                            logMessage(
                                "Quote stream error: " +
                                formatError(
                                    error
                                ),
                                "error"
                            );


                            return of(null);
                        }
                    )
                )
                .subscribe();
    }


    logMessage(
        `Subscribing to XAUUSD live quotes. Symbol ID: ${state.symbolId}`
    );


    subscribeQuotes(
        adapter,
        {

            symbolId: [
                Number(
                    state.symbolId
                )
            ],

            enableStaleQuotesFiltering:
                true,

            subscribeToSpotTimestamp:
                true
        }
    )
        .pipe(

            take(1),

            tap((result) => {

                console.log(
                    "subscribeQuotes response:",
                    result
                );


                state.quotesSubscribed =
                    true;


                setButtonState(
                    ui.startButton,
                    false,
                    "Start Automated Strategy"
                );


                setButtonState(
                    ui.resetButton,
                    false,
                    "Reset Reference Price"
                );


                logMessage(
                    "Live XAUUSD quote subscription accepted.",
                    "success"
                );
            }),


            catchError(
                (error) => {

                    state.quotesSubscribed =
                        false;


                    logMessage(
                        "Quote subscription failed: " +
                        formatError(
                            error
                        ),
                        "error"
                    );


                    return of(null);
                }
            )
        )
        .subscribe();
}


/* ============================================================
   PROCESS LIVE QUOTE
   ============================================================ */

function processQuote(
    result
) {

    if (
        !result
    ) {

        return;
    }


    const quote =
        result?.quote ??
        result?.payload?.quote ??
        result?.payload ??
        result;


    const quoteSymbolId =
        quote?.symbolId ??
        result?.symbolId;


    /*
        Ignore quotes from another symbol
    */

    if (
        quoteSymbolId !==
            undefined
        &&
        Number(
            quoteSymbolId
        )
        !==
        Number(
            state.symbolId
        )
    ) {

        return;
    }


    const bid =
        extractPrice(
            quote,
            [
                "bid",
                "bidPrice",
                "bidValue"
            ]
        );


    const ask =
        extractPrice(
            quote,
            [
                "ask",
                "askPrice",
                "askValue"
            ]
        );


    if (
        bid !== null
    ) {

        state.bid =
            bid;


        setText(
            ui.bid,
            formatPrice(
                bid
            )
        );
    }


    if (
        ask !== null
    ) {

        state.ask =
            ask;


        setText(
            ui.ask,
            formatPrice(
                ask
            )
        );
    }


    const usablePrice =
        state.bid !== null
            ?
            state.bid
            :
            state.ask;


    /*
        Automatically establish initial reference
    */

    if (
        state.referencePrice ===
            null
        &&
        usablePrice !==
            null
    ) {

        setReferencePrice(
            usablePrice,
            "Initial reference price"
        );
    }


    /*
        Calculate movement from reference price
    */

    if (
        state.referencePrice !==
            null
        &&
        usablePrice !==
            null
    ) {

        state.priceMovement =
            usablePrice -
            state.referencePrice;


        setText(
            ui.movement,
            formatSignedPrice(
                state.priceMovement
            )
        );
    }


    updateTradingWindowDisplay();


    /*
        IMPORTANT:

        Stochastic is not calculated from tick prices.

        A proper 5,3,3 Stochastic requires candle:
        High
        Low
        Close

        Trendbar data will be added after live market
        connectivity has been confirmed.
    */


    if (
        state.strategyRunning
    ) {

        evaluateStrategyWithoutOrderExecution();
    }
}


/* ============================================================
   EXTRACT PRICE
   ============================================================ */

function extractPrice(
    object,
    keys
) {

    for (
        const key
        of keys
    ) {

        const value =
            object?.[key];


        if (
            value !== null
            &&
            value !== undefined
            &&
            Number.isFinite(
                Number(
                    value
                )
            )
        ) {

            return Number(
                value
            );
        }
    }


    return null;
}


/* ============================================================
   PRICE FORMATTING
   ============================================================ */

function formatPrice(
    value
) {

    if (
        !Number.isFinite(
            Number(
                value
            )
        )
    ) {

        return "--";
    }


    return Number(
        value
    ).toFixed(
        state.symbolDigits
    );
}


function formatSignedPrice(
    value
) {

    if (
        !Number.isFinite(
            Number(
                value
            )
        )
    ) {

        return "--";
    }


    const number =
        Number(
            value
        );


    const sign =
        number > 0
            ?
            "+"
            :
            "";


    return (
        sign +
        number.toFixed(
            state.symbolDigits
        )
    );
}


/* ============================================================
   REFERENCE PRICE
   ============================================================ */

function setReferencePrice(
    price,
    reason
) {

    if (
        !Number.isFinite(
            Number(
                price
            )
        )
    ) {

        return;
    }


    state.referencePrice =
        Number(
            price
        );


    state.priceMovement =
        0;


    setText(
        ui.reference,
        formatPrice(
            state.referencePrice
        )
    );


    setText(
        ui.movement,
        formatSignedPrice(
            0
        )
    );


    logMessage(
        `${reason}: ${formatPrice(state.referencePrice)}`,
        "success"
    );
}


/* ============================================================
   RESET REFERENCE
   ============================================================ */

function resetReferencePrice() {

    const price =
        state.bid !== null
            ?
            state.bid
            :
            state.ask;


    if (
        price === null
    ) {

        logMessage(
            "Cannot reset reference price because no live quote is available.",
            "warning"
        );

        return;
    }


    setReferencePrice(
        price,
        "Reference price reset"
    );
}


/* ============================================================
   START STRATEGY
   ============================================================ */

function startStrategy() {

    if (
        !state.connected
    ) {

        logMessage(
            "Cannot start strategy. cTrader is not connected.",
            "error"
        );

        return;
    }


    if (
        !state.quotesSubscribed
    ) {

        logMessage(
            "Cannot start strategy. XAUUSD live quotes are not ready.",
            "error"
        );

        return;
    }


    if (
        state.referencePrice ===
            null
    ) {

        resetReferencePrice();
    }


    state.strategyRunning =
        true;


    setText(
        ui.strategyStatus,
        "Running - monitoring only"
    );


    setColour(
        ui.strategyStatus,
        "#30d158"
    );


    setButtonState(
        ui.startButton,
        true,
        "Strategy Running"
    );


    setButtonState(
        ui.stopButton,
        false,
        "Stop Automated Strategy"
    );


    logMessage(
        "Strategy monitoring started.",
        "success"
    );


    logMessage(
        "Automatic order execution is disabled during connection testing.",
        "warning"
    );
}


/* ============================================================
   STOP STRATEGY
   ============================================================ */

function stopStrategy() {

    state.strategyRunning =
        false;


    setText(
        ui.strategyStatus,
        "Stopped"
    );


    setColour(
        ui.strategyStatus,
        ""
    );


    setButtonState(
        ui.startButton,
        !state.quotesSubscribed,
        "Start Automated Strategy"
    );


    setButtonState(
        ui.stopButton,
        true,
        "Stop Automated Strategy"
    );


    logMessage(
        "Strategy monitoring stopped.",
        "warning"
    );
}


/* ============================================================
   PRICE-MOVEMENT MONITOR

   This checks only the $10 movement.

   It DOES NOT place orders.

   Full entry requires:

   BUY
   Price <= Reference - $10
   AND
   Stochastic K > 80

   SELL
   Price >= Reference + $10
   AND
   Stochastic K < 20
   ============================================================ */

function evaluateStrategyWithoutOrderExecution() {

    if (
        state.referencePrice ===
            null
        ||
        state.bid ===
            null
    ) {

        return;
    }


    const movement =
        state.bid -
        state.referencePrice;


    /*
        BUY-price threshold
    */

    if (
        movement <=
        -CONFIG.requiredMove
    ) {

        setText(
            ui.position,
            "BUY price threshold reached - waiting for Stoch K"
        );

        return;
    }


    /*
        SELL-price threshold
    */

    if (
        movement >=
        CONFIG.requiredMove
    ) {

        setText(
            ui.position,
            "SELL price threshold reached - waiting for Stoch K"
        );

        return;
    }


    setText(
        ui.position,
        "No entry condition"
    );
}


/* ============================================================
   CLEAN UP QUOTE SUBSCRIPTION
   ============================================================ */

function cleanUp() {

    if (
        state.quotesSubscribed
        &&
        state.symbolId !==
            null
    ) {

        unsubscribeQuotes(
            adapter,
            {

                symbolId: [
                    Number(
                        state.symbolId
                    )
                ]
            }
        )
            .pipe(

                take(1),

                catchError(
                    () =>
                        of(null)
                )
            )
            .subscribe();
    }


    if (
        state.quoteSubscription
    ) {

        state.quoteSubscription
            .unsubscribe();


        state.quoteSubscription =
            null;
    }
}


/* ============================================================
   BUTTON EVENTS
   ============================================================ */

if (
    ui.startButton
) {

    ui.startButton
        .addEventListener(
            "click",
            startStrategy
        );
}


if (
    ui.stopButton
) {

    ui.stopButton
        .addEventListener(
            "click",
            stopStrategy
        );
}


if (
    ui.resetButton
) {

    ui.resetButton
        .addEventListener(
            "click",
            resetReferencePrice
        );
}


/* ============================================================
   JAVASCRIPT ERROR REPORTING
   ============================================================ */

window.addEventListener(
    "error",
    (event) => {

        logMessage(
            "JavaScript error: " +
            event.message,
            "error"
        );
    }
);


window.addEventListener(
    "unhandledrejection",
    (event) => {

        logMessage(
            "Unhandled request error: " +
            formatError(
                event.reason
            ),
            "error"
        );
    }
);


/* ============================================================
   PAGE CLEANUP
   ============================================================ */

window.addEventListener(
    "beforeunload",
    cleanUp
);


/* ============================================================
   START APPLICATION
   ============================================================ */

initialiseDisplay();

updateTradingWindowDisplay();

connectToCTrader();


/*
    Update Singapore trading-window status
    every 30 seconds.
*/

setInterval(
    updateTradingWindowDisplay,
    30000
);
