package com.securecommapp.billing

import android.util.Log
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager

/**
 * Google Play Billing fuer die Vollversion - NUR im Flavor "play"
 * (Bibliothek als playImplementation, Registrierung ueber FlavorPackages).
 * JS-Gegenstueck: PlayBilling.js, Pruefung und Freischaltung: PlayPurchase.js
 * und LicenseManager.js, Ablauf: PLAY_STORE.md.
 *
 * Dieses Modul prueft und entscheidet NICHTS: es reicht Produktdetails und
 * Kaeufe (originalJson + Signatur, unveraendert) an JS weiter, oeffnet den
 * Kaufdialog und bestaetigt (acknowledge) einen Kauf erst, wenn JS ihn
 * geprueft hat. Kein Server, keine Google Play Developer API.
 *
 * Datenschutz: Kauf-Tokens, Bestellnummern und Kaufdaten werden NIE geloggt.
 *
 * JS (NativeModules.MalachiPlayBilling), alle mit Promise:
 *   connect()                    -> true          | reject(<BillingResponseCode>)
 *   queryProduct(productId)      -> { productId, title, price, priceMicros, currency } | null
 *   launchPurchase(productId)    -> { responseCode }   (Ergebnis danach als Ereignis)
 *   queryPurchases()             -> { purchases: [ Kauf ] }
 *   acknowledge(purchaseToken)   -> true
 * Ereignis "MalachiPlayPurchases": { responseCode, purchases: [ Kauf ] }
 * Kauf: { originalJson, signature, purchaseState: "purchased"|"pending"|"unspecified",
 *         acknowledged, purchaseToken }
 */
class PlayBillingModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx), PurchasesUpdatedListener {

    companion object {
        private const val TAG = "MalachiPlay"
        const val EVENT = "MalachiPlayPurchases"
        // Produkt-IDs der Play Console: Kleinbuchstaben, Ziffern, "_" und ".".
        private val PRODUCT_ID_RE = Regex("^[a-z0-9][a-z0-9._]{0,99}$")
        private const val MAX_TOKEN_LENGTH = 4096

        fun codeName(code: Int): String = when (code) {
            BillingClient.BillingResponseCode.OK -> "OK"
            BillingClient.BillingResponseCode.USER_CANCELED -> "USER_CANCELED"
            BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE -> "SERVICE_UNAVAILABLE"
            BillingClient.BillingResponseCode.BILLING_UNAVAILABLE -> "BILLING_UNAVAILABLE"
            BillingClient.BillingResponseCode.ITEM_UNAVAILABLE -> "ITEM_UNAVAILABLE"
            BillingClient.BillingResponseCode.DEVELOPER_ERROR -> "DEVELOPER_ERROR"
            BillingClient.BillingResponseCode.ERROR -> "ERROR"
            BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> "ITEM_ALREADY_OWNED"
            BillingClient.BillingResponseCode.ITEM_NOT_OWNED -> "ITEM_NOT_OWNED"
            BillingClient.BillingResponseCode.NETWORK_ERROR -> "NETWORK_ERROR"
            BillingClient.BillingResponseCode.SERVICE_DISCONNECTED -> "SERVICE_DISCONNECTED"
            BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED -> "FEATURE_NOT_SUPPORTED"
            -3 -> "SERVICE_TIMEOUT" // veraltet, aeltere Play-Store-Versionen liefern es noch
            else -> "UNKNOWN"
        }
    }

    private class Waiter(val onReady: (BillingClient) -> Unit, val onError: (String) -> Unit)

    private val lock = Any()
    private var client: BillingClient? = null
    private var connecting = false
    private val waiters = mutableListOf<Waiter>()
    private val products = HashMap<String, ProductDetails>()

    override fun getName() = "MalachiPlayBilling"

    // Pflicht fuer NativeEventEmitter in JS.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    // ── Verbindung ────────────────────────────────────────────────────────

    private fun clientOrCreate(): BillingClient = synchronized(lock) {
        client ?: BillingClient.newBuilder(reactApplicationContext)
            .setListener(this)
            // Ausstehende Zahlungen (z. B. Barzahlung im Laden) zulassen - sie
            // schalten in JS erst frei, wenn Google Play sie als bezahlt meldet.
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build()
            .also { client = it }
    }

    /** onReady(client), sobald verbunden - sonst onError(BillingResponseCode als Text). */
    private fun withClient(onReady: (BillingClient) -> Unit, onError: (String) -> Unit) {
        val c = try {
            clientOrCreate()
        } catch (e: Exception) {
            Log.w(TAG, "BillingClient nicht verfuegbar: ${e.javaClass.simpleName}")
            onError("BILLING_UNAVAILABLE")
            return
        }
        if (c.isReady) {
            onReady(c)
            return
        }
        val start = synchronized(lock) {
            waiters.add(Waiter(onReady, onError))
            if (connecting) false else { connecting = true; true }
        }
        if (!start) return
        try {
            c.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) {
                    val list = takeWaiters()
                    if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                        list.forEach { w -> runCatching { w.onReady(c) } }
                    } else {
                        val code = codeName(result.responseCode)
                        list.forEach { w -> runCatching { w.onError(code) } }
                    }
                }

                override fun onBillingServiceDisconnected() {
                    // Spaeter erneut verbinden: der naechste Aufruf sieht isReady == false.
                    takeWaiters().forEach { w -> runCatching { w.onError("SERVICE_DISCONNECTED") } }
                }
            })
        } catch (e: Exception) {
            Log.w(TAG, "startConnection fehlgeschlagen: ${e.javaClass.simpleName}")
            takeWaiters().forEach { w -> runCatching { w.onError("SERVICE_UNAVAILABLE") } }
        }
    }

    private fun takeWaiters(): List<Waiter> = synchronized(lock) {
        connecting = false
        val list = waiters.toList()
        waiters.clear()
        list
    }

    @ReactMethod
    fun connect(promise: Promise) {
        withClient({ promise.resolve(true) }, { code -> promise.reject(code, "Google Play: $code") })
    }

    // ── Produkt ───────────────────────────────────────────────────────────

    private fun fetchProduct(productId: String, onDone: (ProductDetails?) -> Unit, onError: (String) -> Unit) {
        withClient({ c ->
            val params = QueryProductDetailsParams.newBuilder()
                .setProductList(listOf(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(productId)
                        .setProductType(BillingClient.ProductType.INAPP)
                        .build()
                ))
                .build()
            c.queryProductDetailsAsync(params) { result, details ->
                if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                    onError(codeName(result.responseCode))
                    return@queryProductDetailsAsync
                }
                val pd = details.productDetailsList.firstOrNull { it.productId == productId }
                if (pd != null) synchronized(lock) { products[productId] = pd }
                onDone(pd)
            }
        }, onError)
    }

    @ReactMethod
    fun queryProduct(productId: String, promise: Promise) {
        if (!PRODUCT_ID_RE.matches(productId)) {
            promise.reject("DEVELOPER_ERROR", "Ungueltige Produkt-ID")
            return
        }
        fetchProduct(productId, { pd ->
            val offer = pd?.oneTimePurchaseOfferDetails
            if (pd == null || offer == null) {
                promise.resolve(null)
                return@fetchProduct
            }
            promise.resolve(Arguments.createMap().apply {
                putString("productId", pd.productId)
                putString("title", pd.name)
                putString("price", offer.formattedPrice)
                // Als Text: Mikro-Einheiten koennen die Genauigkeit von double sprengen.
                putString("priceMicros", offer.priceAmountMicros.toString())
                putString("currency", offer.priceCurrencyCode)
            })
        }, { code -> promise.reject(code, "Google Play: $code") })
    }

    // ── Kauf ──────────────────────────────────────────────────────────────

    @ReactMethod
    fun launchPurchase(productId: String, promise: Promise) {
        if (!PRODUCT_ID_RE.matches(productId)) {
            promise.reject("DEVELOPER_ERROR", "Ungueltige Produkt-ID")
            return
        }
        val launch: (ProductDetails?) -> Unit = launch@{ pd ->
            if (pd == null) {
                promise.resolve(Arguments.createMap().apply { putString("responseCode", "ITEM_UNAVAILABLE") })
                return@launch
            }
            UiThreadUtil.runOnUiThread {
                val activity = reactApplicationContext.currentActivity
                val c = synchronized(lock) { client }
                if (activity == null || c == null || !c.isReady) {
                    promise.resolve(Arguments.createMap().apply { putString("responseCode", "SERVICE_DISCONNECTED") })
                    return@runOnUiThread
                }
                try {
                    val params = BillingFlowParams.newBuilder()
                        .setProductDetailsParamsList(listOf(
                            BillingFlowParams.ProductDetailsParams.newBuilder()
                                .setProductDetails(pd)
                                .build()
                        ))
                        .build()
                    val result = c.launchBillingFlow(activity, params)
                    promise.resolve(Arguments.createMap().apply { putString("responseCode", codeName(result.responseCode)) })
                } catch (e: Exception) {
                    Log.w(TAG, "Kaufdialog nicht startbar: ${e.javaClass.simpleName}")
                    promise.resolve(Arguments.createMap().apply { putString("responseCode", "ERROR") })
                }
            }
        }
        val cached = synchronized(lock) { products[productId] }
        if (cached != null) {
            withClient({ launch(cached) }, { code -> promise.reject(code, "Google Play: $code") })
        } else {
            fetchProduct(productId, launch, { code -> promise.reject(code, "Google Play: $code") })
        }
    }

    /** Kaufdialog beendet bzw. ausstehende Zahlung abgeschlossen. */
    override fun onPurchasesUpdated(result: BillingResult, purchases: MutableList<Purchase>?) {
        emit(Arguments.createMap().apply {
            putString("responseCode", codeName(result.responseCode))
            putArray("purchases", toArray(purchases))
        })
    }

    @ReactMethod
    fun queryPurchases(promise: Promise) {
        withClient({ c ->
            val params = QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.INAPP).build()
            c.queryPurchasesAsync(params) { result, list ->
                if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                    val code = codeName(result.responseCode)
                    promise.reject(code, "Google Play: $code")
                    return@queryPurchasesAsync
                }
                promise.resolve(Arguments.createMap().apply { putArray("purchases", toArray(list)) })
            }
        }, { code -> promise.reject(code, "Google Play: $code") })
    }

    @ReactMethod
    fun acknowledge(purchaseToken: String, promise: Promise) {
        if (purchaseToken.isEmpty() || purchaseToken.length > MAX_TOKEN_LENGTH) {
            promise.reject("DEVELOPER_ERROR", "Ungueltiges Kauf-Token")
            return
        }
        withClient({ c ->
            val params = AcknowledgePurchaseParams.newBuilder().setPurchaseToken(purchaseToken).build()
            c.acknowledgePurchase(params) { result ->
                if (result.responseCode == BillingClient.BillingResponseCode.OK) promise.resolve(true)
                else codeName(result.responseCode).let { code -> promise.reject(code, "Google Play: $code") }
            }
        }, { code -> promise.reject(code, "Google Play: $code") })
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    private fun toArray(purchases: List<Purchase>?): WritableArray {
        val arr = Arguments.createArray()
        purchases?.forEach { p -> arr.pushMap(toMap(p)) }
        return arr
    }

    private fun toMap(p: Purchase): WritableMap = Arguments.createMap().apply {
        // Unveraendert - JS prueft die Signatur ueber genau diese Bytes.
        putString("originalJson", p.originalJson)
        putString("signature", p.signature)
        putString("purchaseState", when (p.purchaseState) {
            Purchase.PurchaseState.PURCHASED -> "purchased"
            Purchase.PurchaseState.PENDING -> "pending"
            else -> "unspecified"
        })
        putBoolean("acknowledged", p.isAcknowledged)
        putString("purchaseToken", p.purchaseToken)
    }

    private fun emit(params: WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT, params)
        } catch (e: Exception) {
            // JS noch nicht bereit: der Kauf geht nicht verloren - die Abfrage
            // beim naechsten Start (queryPurchases) findet ihn wieder.
            Log.w(TAG, "Kauf-Ereignis nicht zustellbar: ${e.javaClass.simpleName}")
        }
    }

    override fun invalidate() {
        val c = synchronized(lock) { client.also { client = null } }
        runCatching { c?.endConnection() }
        takeWaiters().forEach { w -> runCatching { w.onError("SERVICE_DISCONNECTED") } }
        super.invalidate()
    }
}

/** Nur im Flavor "play" registriert (src/play/java/com/securecommapp/FlavorPackages.kt). */
class PlayBillingPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(PlayBillingModule(context))

    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
