# Rechtliche Einschätzung: Verkauf der Vollversion gegen Monero (XMR)

**Stand der Recherche:** 16. Oktober 2026
**Fall:** Privatperson in Deutschland (geplant: Kleinunternehmer nach § 19 UStG) verkauft die Vollversion eines kostenlosen Android-Messengers für einmalig 2,99 EUR über eine eigene Tor-Onion-Seite. Bezahlt wird in Monero, die Käufer bleiben anonym. Die eingehenden XMR sollen möglichst schnell in Euro getauscht und alle Käufe lückenlos aufgezeichnet werden. Gefragt ist, ob ein Zahlungsdienstleister außerhalb der EU das Problem „EU-Regeln ab 2027“ löst.

> **Wichtiger Hinweis:** Ich bin kein Anwalt und kein Steuerberater. Dies ist eine strukturierte Recherche mit Quellen, keine Rechts- oder Steuerberatung. Sie ersetzt nicht die Prüfung durch eine zugelassene Fachperson. Gesetze, AGB und Anbieterstatus ändern sich schnell. Prüfen Sie jede Aussage vor einer Entscheidung am aktuellen Stand.

**Kennzeichnung im Text:**
- **[Fakt]**: durch die genannte Quelle belegt (Primärquelle bevorzugt).
- **[Einschätzung]**: meine Auslegung oder Schlussfolgerung, nicht amtlich bestätigt.
- **[Unsicher]**: offene Frage, widersprüchliche Quellen oder nicht prüfbar.

---

## Kurzfassung und Empfehlung

1. Die Annahme „Wenn ein Anbieter außerhalb der EU Zahlung und Auszahlung übernimmt, greift die EU-Überwachung nicht mehr“ stimmt so nicht. Das Monero-Verbot in Art. 79 der Geldwäscheverordnung (AMLR) gilt ab 10. Juli 2027 nur für Banken, Finanzinstitute und Krypto-Dienstleister (CASPs). Es gilt nicht für Sie als Händler und nicht für Privatpersonen. Sie dürfen XMR deshalb auch nach 2027 direkt in Ihr eigenes Wallet annehmen. *(Einschätzung auf Basis des Wortlauts.)*
2. Das eigentliche Problem ist nicht die Annahme, sondern der Umtausch in Euro. Nach den verfügbaren Daten bietet im Oktober 2026 schon kein regulierter EU-Anbieter mehr XMR/EUR für deutsche Kunden an. Ab Juli 2027 dürfen EU-CASPs Monero voraussichtlich gar nicht mehr in Konten führen.
3. Ein Gateway aus einem Drittstaat beseitigt dieses Problem nicht, es verlagert es nur. Die Euro landen am Ende auf Ihrem deutschen Bankkonto. Ihre Bank unterliegt voll dem Geldwäscherecht und prüft Zuflüsse aus unregulierten Krypto-Diensten erfahrungsgemäß besonders genau.
4. NOWPayments schließt in seinen aktuellen AGB (Fassung vom 31.08.2026; Vertragspartner FD Transfers LLC, St. Vincent und die Grenadinen) Einwohner und Staatsangehörige der EU ausdrücklich aus. Die EUR-Auszahlung läuft dort nur über einen Drittanbieter, der eine Unternehmensprüfung (KYB) verlangen kann.
5. 1pay.cx gibt sich selbst als litauische UAB aus, hätte also einen Sitz in der EU und nicht in einem Drittstaat. Der Dienst kann Guthaben gepoolt verwahren und behält sich vor, Gelder einzufrieren. Im MiCA-Register der ESMA (Stand etwa 06.10.2026) ist er nicht zu finden. Das bedeutet ein hohes Gegenpartei- und Rechtsrisiko.
6. „XMR Checkout“ ist eine quelloffene Software, die kein Geld verwahrt (sie arbeitet nur mit dem View-Key) und sich selbst hosten lässt. Das ist rechtlich unproblematisch, tauscht aber nichts in Euro.
7. Steuerlich ändert ein ausländischer Dienst nichts. Bei ausländischen Plattformen verlangt das BMF sogar eine erweiterte Mitwirkung (§ 90 Abs. 2 AO; BMF-Schreiben vom 06.03.2025, Rz. 89). Kursgewinne und Kursverluste der XMR im Betriebsvermögen sind ohne Jahresfrist steuerwirksam.
8. **Empfehlung:**
   - XMR, wenn überhaupt, nur selbst gehostet annehmen (MoneroPay oder BTCPay Server mit Monero-Plugin; auf dem Server nur ein View-only-Wallet, Spend-Key offline).
   - Keinen verwahrenden Drittstaaten-Dienst nutzen.
   - Zusätzlich Bitcoin/Lightning über ein selbst gehostetes BTCPay und gegebenenfalls EURC als Zahlungswege anbieten, die auch nach 2027 tragen.
   - Den Ausstieg in Euro über einen MiCA-zugelassenen Anbieter mit BTC oder EURC planen, nicht mit XMR.
9. Lassen Sie vor dem Start zwei Punkte prüfen:
   - durch einen Steuerberater: Gewerbe, EÜR, Leistungsort bei anonymen Käufern, Kleinunternehmerregelung;
   - durch einen Anwalt: Impressum und Verbraucherrecht auf der Onion-Seite, Widerrufsbutton, gegebenenfalls Exportkontrolle für Verschlüsselungssoftware.
10. Beachten Sie: Die Impressums- und Verbraucherinformationspflichten machen Sie als Verkäufer mit Name und Anschrift identifizierbar. Anonym bleiben nur die Käufer.

---

## 1. EU-Geldwäscheverordnung (AMLR, Verordnung (EU) 2024/1624)

Quelle: Amtsblatt-Fassung der [Verordnung (EU) 2024/1624 (EUR-Lex)](https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32024R1624). EUR-Lex war per Skript nicht erreichbar, weil es eine Bot-Schutz-Abfrage zeigt. Der Wortlaut stammt deshalb aus dem identischen Amtsblatt-Dokument des Amts für Veröffentlichungen der EU (L 2024/1624 vom 19.6.2024).

### 1.1 Was ab 10. Juli 2027 gilt

- **[Fakt] Geltungsbeginn:** Die Verordnung gilt nach Art. 90 ab dem 10. Juli 2027. Ausgenommen sind Fußballvermittler und Profivereine, für die sie ab 2029 gilt.
- **[Fakt] Art. 79 Abs. 1 AMLR (Wortlaut):** „Kreditinstitute, Finanzinstitute und Anbieter von Kryptowerte-Dienstleistungen dürfen weder anonyme Bank- und Zahlungskonten, anonyme Sparbücher, anonyme Schließfächer oder anonyme Kryptowertekonten noch sonstige Konten führen, die es in anderer Weise ermöglichen, den Inhaber des betreffenden Kundenkontos zu anonymisieren oder Transaktionen zu anonymisieren oder in hohem Maß zu verschleiern, auch durch anonymitätsverstärkende Kryptowährungen.“
- **[Fakt] Definition (Art. 2 Abs. 1 Nr. 25 AMLR):** „anonymitätsverstärkende Kryptowährungen“ sind „Kryptowerte mit eingebauten Merkmalen, mit denen Informationen über Kryptowertetransfers entweder systematisch oder optional anonymisiert werden sollen“. Monero fällt nach allgemeinem Verständnis darunter, weil Ringsignaturen, Stealth-Adressen und RingCT systematisch wirken. *(Einschätzung; Monero ist im Gesetz nicht namentlich genannt.)*
- **[Fakt] Erwägungsgrund 160:** Danach soll die Bereitstellung und Verwahrung solcher Konten durch Krypto-Dienstleister untersagt werden. Das Verbot gilt aber nicht für Anbieter von Hardware und Software oder von selbst gehosteten Wallets, soweit sie weder Zugang zu diesen Wallets noch Kontrolle darüber haben.

### 1.2 Für wen gilt das Verbot?

| Wer | Erfasst von Art. 79? | Grundlage |
|---|---|---|
| Kreditinstitute (Banken) | **Ja** | Art. 79 Abs. 1 |
| Finanzinstitute, dazu gehören CASPs (Art. 2 Abs. 1 Nr. 6 lit. i) | **Ja** | Art. 79 Abs. 1, Art. 2 Abs. 1 Nr. 6 |
| Krypto-Dienstleister im Sinne von MiCA (Börsen, Verwahrer, Tauschdienste) | **Ja** | Art. 2 Abs. 1 Nr. 9 AMLR i. V. m. Art. 3 Abs. 1 Nr. 15 MiCA |
| Händler, der XMR in sein **eigenes** Wallet annimmt | **Nein** *(Einschätzung)* | Er ist nicht Adressat von Art. 79 und kein Verpflichteter nach Art. 3 (siehe unten) |
| Privatperson, die XMR hält | **Nein** | Art. 79 regelt nur Konten bei Instituten. Ein Besitzverbot enthält die AMLR nicht. |
| Anbieter von Wallet-Software ohne Zugriff (z. B. MoneroPay, BTCPay, XMR Checkout als Software) | **Nein** | Erwägungsgrund 160 |

- **[Fakt]** Art. 3 AMLR zählt die Verpflichteten abschließend auf: Kreditinstitute, Finanzinstitute und bestimmte Berufe und Branchen, etwa Steuerberater, Immobilienmakler, Händler mit Edelmetallen oder hochwertigen Gütern, Glücksspielanbieter und Kulturguthändler ab 10.000 EUR. Ein Verkäufer von Software-Lizenzen für 2,99 EUR gehört nicht dazu.
- **[Fakt]** Für Barzahlungen gilt Art. 80 AMLR (Obergrenze 10.000 EUR). Krypto ist kein Bargeld, deshalb ist die Vorschrift hier irrelevant.
- **[Einschätzung]** Nach dem Wortlaut verbietet Art. 79 nicht Monero als solches, sondern das Führen von Konten, die eine Anonymisierung ermöglichen. In der Praxis lesen Markt und Kommentatoren die Vorschrift als faktisches Verbot für EU-CASPs, XMR zu verwahren, zu tauschen oder zu handeln. Darauf deuten auch die bereits erfolgten Delistings hin (Abschnitt 2.3).
- **[Unsicher]** Ob die EU-Geldwäschebehörde AMLA oder die Aufsichtsbehörden Art. 79 enger auslegen, etwa so, dass XMR mit vollständiger Identifizierung des Inhabers erlaubt bleibt, ist offen. Ich habe bis 16.10.2026 keine AMLA-Leitlinie speziell zu Art. 79 gefunden. Rechnen Sie nicht mit einer Lockerung.

### 1.3 „Self-hosted addresses“ (selbst gehostete Adressen)

- **[Fakt] Definition:** Art. 2 Abs. 1 Nr. 14 AMLR verweist auf Art. 3 Nr. 20 der Geldtransferverordnung (EU) 2023/1113. Danach ist eine selbst gehostete Adresse eine Distributed-Ledger-Adresse ohne Verbindung zu (a) einem Krypto-Dienstleister oder (b) einer Einrichtung außerhalb der Union, die vergleichbare Dienstleistungen erbringt.
- **[Fakt] Art. 40 AMLR:** CASPs müssen Transfers von und zu selbst gehosteten Adressen risikobasiert bewerten. Dazu gehören mindestens eine der folgenden Maßnahmen: Identitätsprüfung des Originators bzw. Begünstigten, Fragen nach Herkunft und Bestimmung der Mittel oder verstärkte Überwachung. Bis 10.07.2027 gibt die AMLA dazu Leitlinien heraus.
- **[Einschätzung] Bedeutung für Sie:** Ihr eigenes Monero-Wallet ist eine selbst gehostete Adresse. Das ist erlaubt. Es löst aber Prüfungen aus, sobald Sie Werte an einen EU-CASP senden (Abschnitt 2.2).
- **[Einschätzung] Wichtig zur Ausgangsfrage:** Ein Wallet bei einem Drittstaaten-Gateway wie NOWPayments ist nach der Definition gerade keine selbst gehostete Adresse, sondern eine Adresse einer „Einrichtung außerhalb der Union, die vergleichbare Dienstleistungen erbringt“. Ein EU-CASP behandelt Eingänge von dort deshalb wie einen Transfer von einem anderen Dienstleister und prüft dessen Seriosität.

---

## 2. MiCA (VO (EU) 2023/1114) und Geldtransferverordnung / Travel Rule (VO (EU) 2023/1113)

Quellen: [MiCA (EUR-Lex)](https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32023R1114), [VO (EU) 2023/1113 (EUR-Lex)](https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32023R1113), jeweils Amtsblatt-Fassung.

### 2.1 Relevanz für den Händler selbst

- **[Fakt]** Eine Krypto-Dienstleistung (Art. 3 Abs. 1 Nr. 16 MiCA) ist unter anderem die Verwahrung „für Kunden“, der Tausch von Kryptowerten gegen Geld oder andere Kryptowerte, die Ausführung von Aufträgen „für Kunden“ und Transferdienstleistungen „für Kunden“. CASP ist, wer solche Dienste „gewerblich für Kunden“ erbringt (Nr. 15). Dafür ist eine Zulassung nötig (Art. 59).
- **[Einschätzung]** Wer Kryptowerte als Bezahlung für die eigene Software annimmt, erbringt keine Krypto-Dienstleistung für Kunden. Sie brauchen also keine MiCA-Zulassung. Dasselbe gilt, wenn Sie gelegentlich eigene XMR über einen Anbieter verkaufen. Eine ausdrückliche BaFin-Aussage zu genau diesem Fall habe ich nicht gefunden.
- **[Unsicher]** Grenzfall: Verkaufen Sie XMR regelmäßig und systematisch direkt an andere Personen gegen Euro, etwa auf P2P-Marktplätzen, ist nicht ausgeschlossen, dass das als „Tausch von Kryptowerten gegen einen Geldbetrag unter Einsatz eigenen Kapitals“ (Art. 3 Abs. 1 Nr. 19 MiCA) eingestuft wird, also als erlaubnispflichtig. Für gelegentliche Verkäufe eigener Bestände halte ich das für fernliegend. Lassen Sie es aber prüfen, wenn Sie P2P-Verkäufe planen.

### 2.2 Travel Rule (VO 2023/1113)

- **[Fakt]** Die Verordnung gilt für Kryptowertetransfers, bei denen der CASP des Originators oder des Begünstigten seinen Sitz in der Union hat (Art. 2 Abs. 1). Sie gilt **nicht** für Transfers von Person zu Person ohne Beteiligung eines CASP (Art. 2 Abs. 4 Unterabs. 3 lit. b).
- **[Einschätzung]** Zahlt ein Käufer aus seinem eigenen Wallet an Ihr eigenes Wallet, greift die Travel Rule nicht.
- **[Fakt]** Senden Sie später Werte von Ihrem eigenen Wallet an einen EU-CASP, muss dieser die Angaben zum Originator einholen und aufbewahren. Bei mehr als 1.000 EUR muss er zusätzlich prüfen, ob die Adresse Ihnen gehört oder von Ihnen kontrolliert wird (Art. 16 Abs. 2).
- **[Fakt]** Fehlen die Pflichtangaben, muss der CASP risikobasiert entscheiden: Er kann den Transfer zurückweisen, zurücksenden oder aussetzen (Art. 17).
- **[Einschätzung]** Bei Einzahlungen von einem Drittstaaten-Gateway braucht der EU-CASP Travel-Rule-Daten von diesem Gateway. Fehlen sie oder ist das Gateway unbekannt beziehungsweise unreguliert, steigt das Risiko, dass die Einzahlung blockiert oder hinterfragt wird.

### 2.3 Anbieter aus Drittstaaten und Reverse Solicitation

- **[Fakt]** Art. 61 MiCA: Beginnt ein in der EU ansässiger Kunde auf ausschließlich eigene Initiative eine Dienstleistung bei einem Drittstaatenunternehmen, entfällt für diese Dienstleistung die Zulassungspflicht. Das gilt aber nicht, sobald das Unternehmen in der EU Kunden akquiriert, und zwar unabhängig von Vertragsklauseln, die etwas anderes behaupten.
- **[Fakt]** Die ESMA versteht diese Ausnahme sehr eng. Werbung, auch Markenwerbung, und Online-Aktivitäten können bereits als Akquise gelten. Siehe die [ESMA-Leitlinien zur Reverse Solicitation, ESMA35-1872330276-2030 (DE)](https://www.esma.europa.eu/sites/default/files/2025-02/ESMA35-1872330276-2030_Guidelines_on_reverse_solicitation_under_MiCA_DE.pdf).
- **[Fakt]** Die MiCA-Übergangsfrist für Bestandsanbieter endete EU-weit spätestens am 1. Juli 2026 (Art. 143 Abs. 3 MiCA). Die ESMA hat nicht zugelassene Anbieter aufgefordert, ihr EU-Geschäft geordnet abzuwickeln, keine neuen EU-Kunden mehr aufzunehmen und keine Werbung mehr zu machen ([ESMA Public Statement, Juni 2026](https://www.esma.europa.eu/sites/default/files/2026-06/ESMA75-113276571-1710_Public_Statement_MiCA_transitional_period_ends.pdf)). Kunden nicht zugelassener Anbieter genießen nicht den Schutz von MiCA, etwa beim Schutz von Kundenvermögen.
- **[Fakt]** MiCA verbietet nicht Ihnen als Kunden, einen Drittstaatenanbieter zu nutzen. Die Zulassungspflicht trifft den Anbieter.

### 2.4 Delistings von Monero und Stand Oktober 2026

- **[Fakt] MiCA Art. 76 Abs. 3:** Die Betriebsvorschriften einer Handelsplattform schließen die Zulassung von Kryptowerten mit eingebauter Anonymisierungsfunktion zum Handel aus. Das gilt nur dann nicht, wenn der Plattformbetreiber die Inhaber und deren Transaktionshistorie identifizieren kann. Diese Vorschrift gilt bereits heute, also vor der AMLR.
- **[Fakt] Binance:** Delisting von XMR weltweit zum 20.02.2024 ([The Block](https://www.theblock.co/post/276176/binance-delisting-monero)).
- **[Fakt] Kraken:** Zuerst Irland und Belgien (2024, laut [Cointelegraph](https://cointelegraph.com/news/kraken-ends-monero-support-european-economic-area)). Für den gesamten EWR wurden Handel und Einzahlungen am 31.10.2024 eingestellt. Abhebungen waren bis 31.12.2024 möglich, Restbestände wurden bis 06.01.2025 in BTC umgetauscht ([Kraken Support](https://support.kraken.com/hc/articles/support-for-monero-xmr-in-europe)).
- **[Fakt, Sekundärquelle] Stand 05.10.2026:**
  - Laut einer Stichprobe von cryptoticker.io führen Bitpanda, Bitvavo, Coinbase, Bitstamp, Gate.io und OKX kein XMR-Paar.
  - Kraken listet XMR-Paare einschließlich XMR/EUR, sperrt sie aber für EWR-Kunden.
  - KuCoin listet XMR, hat aber keine EU-Zulassung für Deutschland.
  - Quelle: [cryptoticker.io, 06./12.10.2026](https://cryptoticker.io/de/monero-kaufen-delisting/).
- **[Einschätzung]** Mir ist für Oktober 2026 **kein regulierter EU-Anbieter** bekannt, der deutschen Kunden XMR/EUR anbietet. Das lässt sich nicht abschließend prüfen, weil das ESMA-Register ([CASPS.csv](https://www.esma.europa.eu/sites/default/files/2024-12/CASPS.csv), etwa 370 Einträge, letzte Änderungen Anfang Oktober 2026) keine einzelnen Kryptowerte ausweist. Ab dem 10.07.2027 ist wegen Art. 79 AMLR praktisch nicht mehr damit zu rechnen.

---

## 3. Ausländische Zahlungsdienstleister

### 3.1 Die drei genannten Dienste

| | **NOWPayments** | **1pay.cx** | **„XMR Checkout“** |
|---|---|---|---|
| Was ist das? | Gehosteter Krypto-Zahlungsdienst (Gateway), ursprünglich von ChangeNOW gestartet | Gehosteter Zahlungsdienst für Karte und Krypto (BTC, LTC, XMR, Stablecoins); wirbt mit „no KYB“ und zielt auf „high-risk“-Branchen | Quelloffene Software (MIT-Lizenz) für Monero-Rechnungen auf Basis des View-Keys; gehostete Instanz auf xmrcheckout.com oder selbst gehostet |
| Sitz / Vertragspartner | **FD Transfers LLC, St. Vincent und die Grenadinen** ([AGB, Stand 31.08.2026](https://nowpayments.io/doc/fd-tos.pdf)); Büros laut Website in NL und EE ([About](https://nowpayments.io/help/about-nowpayments)) | Laut eigenen Rechtstexten **„1PayCX UAB“, Litauen**, Firmencode 304592831, Vilnius ([Website](https://1pay.cx/), [AGB](https://1pay.cx/terms); Angaben aus dem Seitencode, **nicht in einem Register verifiziert**) | Betreiber der gehosteten Instanz nicht angegeben; Code auf [GitHub](https://github.com/xmrcheckout/xmrcheckout), Repo seit 01/2026, letzte Änderung 08/2026 |
| Regulierung | Keine Zulassung angegeben; **nicht im ESMA-MiCA-Register** | **Nicht im ESMA-MiCA-Register** (CASPS.csv und NCASP.csv, Stand etwa 06.10.2026) | Keine nötig, solange nur Software ohne Zugriff auf Gelder |
| Bedient EU-Kunden? | **Nein, laut AGB Ziff. 15.1:** keine Dienste für Einwohner oder Staatsangehörige der EU, UK, USA, VAE; Nutzung auf eigenes Risiko | Keine Länderbeschränkung außer Sanktionen gefunden. Laut AGB unterliegt der Dienst litauischem Recht, Schiedsgericht in Vilnius | Software, frei nutzbar |
| KYC / KYB für Händler | KYB nach Ermessen des Fiat-Partners (Ziff. 10.8); künftige KYC-Pflicht angekündigt (Ziff. 23.3) | Wirbt mit „no KYB“, behält sich aber in AGB Ziff. 3 jederzeit Identitäts-, Unternehmens- und Mittelherkunftsprüfung vor, auch vor Auszahlungen | Keine |
| EUR-Auszahlung | Nur über Drittanbieter; nur aus Guthaben in **USDT (TRON)**, vorher Umtausch mit Gebühr (Ziff. 10.5); Ziel ist ein Bankkonto | Keine EUR-Auszahlung; Auszahlung nur in Krypto | **Keine** (nur Zahlungserkennung, Beträge in XMR) |
| Verwahrung | Optionales „Custody“-Guthaben bei Drittanbietern, für die FD Transfers nicht haftet (Ziff. 8.3); Fiat-Auszahlung **setzt Custody voraus** (Ziff. 10.2) | Guthaben werden in Wallets des Anbieters gehalten, **gepoolt** mit fremden und eigenen Beständen (AGB Ziff. 7); bei XMR teils gebündelte Auszahlung | Keine Verwahrung; Software „kann nicht ausgeben“ |
| Einfrieren / Zurückhalten | Drittanbieter darf Transaktionen verweigern, verzögern oder stornieren (Ziff. 8.9, 11.3.1) | Ausdrückliches Recht zu „hold, freeze or delay“ sowie Aufrechnung (AGB Ziff. 8) | Nicht anwendbar |
| Gebühren | Laut [Preisseite](https://nowpayments.io/pricing) 1 % Servicegebühr, zuzüglich Netzwerk- und Umtauschgebühren | Laut Website 1 % für Krypto | Laut Website keine Servicegebühr |
| Rechtsweg bei Verlust | Recht von St. Vincent und den Grenadinen, Gerichte am Sitz in SVG (Ziff. 22) | Litauisches Recht, Schiedsverfahren in Vilnius, Ausschluss von Sammelklagen (AGB Ziff. 16, 17) | Nicht anwendbar |

- **[Fakt]** Die Angaben in der Tabelle stammen aus den verlinkten Anbieterdokumenten, abgerufen am 15./16.10.2026. Ob NOWPayments XMR derzeit unterstützt, war der Preisseite nicht zu entnehmen. Laut Drittquellen ist das der Fall. **[Unsicher]**
- **[Einschätzung] zu 1pay.cx:** Der Dienst stellt sich auf der Website als „non-custodial“ dar, die AGB beschreiben aber verwahrte und gepoolte Guthaben, Swaps und ein Einfrierrecht. Dieser Widerspruch ist ein Warnsignal. Stimmt die Angabe zum litauischen Sitz, handelt es sich um ein EU-Unternehmen. Für Verwahrung und Tausch bräuchte es dann eine MiCA-Zulassung, die im ESMA-Register nicht verzeichnet ist. Stimmt die Angabe nicht, ist die Identität des Betreibers unklar. Beides spricht gegen eine Nutzung. Ich konnte den Firmencode nicht im litauischen Register prüfen. **[Unsicher]**
- **[Einschätzung] zu „XMR Checkout“:** Gemeint sein können drei Dinge, die man trennen muss:
  1. **Selbst gehostete Software ohne Zugriff auf Gelder:** [XMR Checkout](https://xmrcheckout.com/) selbst gehostet, [MoneroPay](https://moneropay.eu/) ([Repo, GPL-3.0](https://gitlab.com/moneropay/moneropay)) oder [BTCPay Server mit dem Community-Plugin für Monero](https://github.com/btcpay-monero/btcpayserver-monero-plugin) (MIT, aktiv gepflegt, letzte Änderung 14.10.2026). Die Zahlungen gehen direkt in Ihr eigenes Wallet. Das ist rechtlich die sauberste Lösung (siehe Erwägungsgrund 160 AMLR).
  2. **Gehostete View-Key-Dienste** wie xmrcheckout.com: Kein Verwahrrisiko. Aber Sie geben Ihren privaten View-Key an einen unbekannten Betreiber, der damit alle Ihre Zahlungseingänge sehen kann. Das ist ein Datenschutzrisiko für Sie, nicht für die Käufer. Die Seite rät selbst dazu, eine eigene Instanz zu betreiben.
  3. **Verwahrende Gateways** wie NOWPayments-Custody oder 1pay-Guthaben: Die Risiken sind oben beschrieben.

### 3.2 Ist die Nutzung für einen deutschen Händler legal?

- **[Einschätzung]** Ein ausdrückliches Verbot für Kunden, einen nicht zugelassenen Drittstaaten-Dienst zu nutzen, habe ich weder in MiCA, AMLR, GwG noch im KWG gefunden. Die Erlaubnispflicht trifft den Anbieter (Art. 59 MiCA). Für den Nutzer ist die Nutzung grundsätzlich nicht strafbar.
- **[Fakt] Aber NOWPayments:** Laut Ziff. 15.1 der eigenen AGB erbringt NOWPayments für EU-Einwohner keine Dienste. Wenn Sie sich trotzdem anmelden, haben Sie kaum eine vertragliche Grundlage. Konto und Guthaben können jederzeit gesperrt werden (Ziff. 15.5).
- **[Einschätzung]** Falsche Angaben zum Wohnsitz sollten Sie keinesfalls machen. Das wäre vertragswidrig und kann je nach Ablauf auch strafrechtlich relevant werden.
- **[Einschätzung] Reverse Solicitation hilft Ihnen nicht.** Sie ist eine Ausnahme für den Anbieter, nicht ein Recht des Kunden. Wer mit deutschsprachigen Seiten wirbt, akquiriert ohnehin aktiv in der EU.

### 3.3 Konkrete Risiken

1. **Bank:**
   - **[Fakt]** Deutsche Banken sind Verpflichtete nach dem GwG. Bei Auffälligkeiten müssen sie Verdachtsmeldungen an die FIU abgeben (§ 43 GwG) und dürfen den Kunden darüber nicht informieren (§ 47 GwG).
   - **[Fakt, Kanzleiquelle]** Laut [WINHELLER, 05.05.2026](https://winheller.com/blog/kontosperre-bankkuendigung-kryptovermoegen/) lösen Zahlungseingänge von Kryptobörsen regelmäßig vertiefte Prüfungen und Anfragen zur Mittelherkunft aus. Das kann bis zur Kontosperre oder Kündigung führen.
   - **[Einschätzung]** Zuflüsse über einen nicht zugelassenen Offshore-Dienst, der Monero in USDT tauscht und dann über einen Fiat-Partner auszahlt, sind aus Sicht einer Bank deutlich riskanter als Zuflüsse von einem MiCA-zugelassenen Anbieter. Bei Monero-Herkunft ist eine lückenlose Kette ab dem Kunden technisch kaum darstellbar. Ihr bester Nachweis sind Ihre eigenen Verkaufsaufzeichnungen.
2. **Kontoart:**
   - **[Einschätzung]** Viele Banken untersagen in ihren AGB die geschäftliche Nutzung privater Girokonten. Nutzen Sie ein Geschäftskonto und informieren Sie die Bank vorab über das Geschäftsmodell. Das ist besser, als später Fragen beantworten zu müssen.
3. **Verwahrrisiko:**
   - **[Fakt]** Guthaben bei NOWPayments-Custody oder 1pay sind keine Einlagen und durch keine Einlagensicherung geschützt (1pay AGB Ziff. 2).
   - **[Fakt]** Bei 1pay sind die Bestände gepoolt (Ziff. 7).
   - **[Einschätzung]** Bei Insolvenz, Hack oder behördlicher Sperre des Anbieters ist ein Totalverlust möglich.
4. **Durchsetzbarkeit:**
   - **[Fakt]** Die Gerichtsstände sind St. Vincent (NOWPayments) bzw. ein Schiedsgericht in Vilnius (1pay).
   - **[Einschätzung]** Für einen Kleinunternehmer ist eine Klage wegen einiger hundert Euro wirtschaftlich aussichtslos. Verbraucherschutz greift für Sie nicht, weil Sie als Händler auftreten.
5. **Daten:**
   - **[Einschätzung]** Ein verwahrendes Gateway kennt alle Ihre Umsätze, verlangt gegebenenfalls Ihre Ausweis- und Unternehmensdokumente und Ihre IBAN. Es sitzt teils außerhalb des Anwendungsbereichs der DSGVO-Aufsicht. Für Ihre Privatsphäre ist das eher schlechter als ein selbst gehostetes Wallet.
6. **Steuertransparenz:**
   - **[Fakt]** Nach DAC8 ([Richtlinie (EU) 2023/2226](https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32023L2226), Erwägungsgründe 17 und 18) müssen auch Kryptowert-Betreiber aus Drittstaaten, die Nutzer in der EU bedienen, über diese melden und sich dazu in einem Mitgliedstaat registrieren.
   - **[Fakt]** In Deutschland gilt seit 01.01.2026 das Kryptowerte-Steuertransparenzgesetz (Überblick: [Haufe](https://www.haufe.de/id/beitrag/steuerliche-informationspflicht-fuer-anbieter-von-kryptowerte-dienstleistungen-HI17067328.html)).
   - **[Unsicher]** Ob ein bestimmter Offshore-Dienst diese Pflicht tatsächlich erfüllt, ist nicht prüfbar.

### 3.4 Ändert ein ausländischer Dienst die deutschen Steuer- und Aufzeichnungspflichten?

**Nein.**
- **[Fakt]** Sie sind in Deutschland unbeschränkt steuerpflichtig (Wohnsitz). Ihre Einkünfte, Aufzeichnungs- und Aufbewahrungspflichten hängen nicht davon ab, über wen Sie kassieren.
- **[Fakt]** Das BMF stellt ausdrücklich klar: Werden Kryptowerte über Plattformen ausländischer Betreiber erworben oder veräußert, gilt eine **erweiterte Mitwirkungspflicht** nach § 90 Abs. 2 AO. Fehlende Aufzeichnungen und Datenverluste, etwa durch Insolvenz oder Hack der Plattform, gehen zulasten der Steuerpflichtigen ([BMF-Schreiben vom 06.03.2025, Rz. 89](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-03-06-einzelfragen-kryptowerte-bmf-schreiben.pdf)).
- **[Einschätzung]** Ein ausländischer Dienst macht Ihre Nachweispflichten also eher schwerer. Sichern Sie dort regelmäßig vollständige Exporte.

### 3.5 Freundliche, aber klare Korrektur der Annahme

> „Wenn ein Anbieter außerhalb der EU die Zahlung und Auszahlung komplett übernimmt, greift die EU-Überwachung nicht mehr.“

- **Für Sie selbst gab es nie eine EU-Überwachung, die man umgehen müsste.** Die AMLR verpflichtet nicht den Händler, sondern Banken und Krypto-Dienstleister. XMR direkt in Ihr eigenes Wallet anzunehmen, bleibt auch nach Juli 2027 erlaubt *(Einschätzung)*.
- **Am Euro-Ende bleiben Sie immer im EU-System.** Euro erreichen Sie praktisch nur über ein EU-Bankkonto oder einen EU-CASP. Beide unterliegen voll dem Geldwäscherecht und der Travel Rule. Ein Offshore-Zwischenschritt macht den Zufluss für die Bank verdächtiger, nicht unsichtbarer.
- **Der bekannteste Anbieter (NOWPayments) will EU-Kunden gar nicht.** Der zweite (1pay.cx) gibt selbst einen EU-Sitz an. Er wäre also gar nicht „außerhalb der EU“ und hätte nach heutigem Registerstand keine MiCA-Zulassung.
- **Steuerlich ändert sich nichts.** Die Nachweislast steigt sogar.

---

## 4. Alternativen ohne Vermittler

### 4.1 XMR selbst annehmen (rechtlich zulässig)

- **[Einschätzung] Zulässigkeit:**
  - Annahme in ein eigenes Wallet: nicht von Art. 79 AMLR erfasst (Abschnitt 1).
  - Keine MiCA-Zulassung nötig (Abschnitt 2.1).
  - Travel Rule nicht anwendbar bei Zahlung von Person zu Person (Art. 2 Abs. 4 VO 2023/1113).
  - Das gilt nach heutigem Stand auch nach dem 10.07.2027.
- **Technisch empfohlen:**
  - Auf dem Onion-Server nur ein **View-only-Wallet** (Adresse plus privater View-Key) betreiben. Der Spend-Key bleibt offline.
  - Pro Rechnung eine eigene Subadresse verwenden, damit Zahlung und Rechnungsnummer eindeutig zusammengehören.
  - Werkzeuge: MoneroPay, BTCPay Server mit Monero-Plugin oder eine selbst gehostete Instanz von XMR Checkout.
  - Hinweis: Laut Plugin-Dokumentation teilt sich beim BTCPay-Monero-Plugin eine Instanz ein Wallet für alle Shops. Nutzen Sie es deshalb nicht auf einer geteilten Instanz.
- **Für die Steuer:**
  - View-Key und Wallet-Datei aufbewahren, um Eingänge später nachweisen zu können.
  - Bei Bedarf Zahlungsnachweise (Tx-Proofs) erzeugen können.

### 4.2 Praktische Probleme beim Umtausch in EUR ab 2027

- **[Fakt/Einschätzung]** Es gibt keinen regulierten EU-Weg XMR→EUR mehr (Abschnitt 2.4). Was bleibt:
  1. **Tausch XMR→BTC (oder →EURC) über nicht verwahrende Wege**, etwa Atomic Swaps oder dezentrale P2P-Börsen, danach BTC→EUR bei einem MiCA-zugelassenen Anbieter.
     - Rechtlich ist das für Sie als Privatperson bzw. Händler nicht verboten *(Einschätzung)*.
     - Aber: Der EU-Anbieter fragt nach der Herkunft der BTC. Chain-Analyse-Werkzeuge können Atomic-Swap- oder No-KYC-Herkünfte als erhöhtes Risiko markieren. **[Unsicher, wie streng das in der Praxis gehandhabt wird.]**
  2. **Tausch über „Instant-Exchange“-Dienste außerhalb der EU.** Für den Anbieter ist das nach MiCA unzulässig, wenn er EU-Kunden bedient. Für Sie bestehen Verwahr- und Sperrrisiko während des Tauschs (Abschnitt 3.3). Nicht empfohlen.
  3. **P2P-Verkauf gegen SEPA an Privatpersonen.** Das bedeutet viele Zahlungseingänge von Fremden auf Ihrem Konto, also ein hohes Risiko von Bankrückfragen. Bei Regelmäßigkeit besteht außerdem ein Abgrenzungsrisiko zur erlaubnispflichtigen Krypto-Dienstleistung (Abschnitt 2.1). Nicht empfohlen.
  4. **XMR halten und Kursrisiko akzeptieren.** Bei 2,99 EUR pro Verkauf ist das Kursrisiko absolut gering. Tauschgebühren und Mindestbeträge machen einen sofortigen Einzelumtausch ohnehin unwirtschaftlich. Ein Sammelumtausch, etwa monatlich, ist realistischer.
- **[Fakt]** Strafrecht: Wer leichtfertig nicht erkennt, dass ein Gegenstand aus einer Straftat stammt, kann sich der leichtfertigen Geldwäsche strafbar machen ([§ 261 Abs. 6 StGB](https://www.gesetze-im-internet.de/stgb/__261.html)).
- **[Einschätzung]** Für reguläre Verkäufe einer Software zum Marktpreis ist das ein fernliegendes Risiko. Es wird aber relevanter, wenn Sie über dubiose Tauschdienste gehen oder ungewöhnliche Zahlungsmuster ignorieren, etwa sehr hohe Überzahlungen.
- **[Fakt]** Für Güterhändler bestehen GwG-Sorgfaltspflichten nur bei Barzahlungen ab 2.000 EUR (hochwertige Güter) bzw. 10.000 EUR sowie bei Kunst ab 10.000 EUR ([§ 10 Abs. 6a GwG](https://www.gesetze-im-internet.de/gwg_2017/__10.html)). Für Sie spielen sie praktisch keine Rolle.

### 4.3 Robustere Zusatzwege

| Weg | Vorteile | Nachteile / Risiken |
|---|---|---|
| **Bitcoin on-chain** über selbst gehostetes BTCPay Server | Bleibt nach 2027 bei EU-CASPs handel- und auszahlbar, ist kein „anonymitätsverstärkender“ Kryptowert; nicht verwahrend | Für Käufer weniger privat (öffentliche Blockchain); Gebühren bei kleinen Beträgen relativ hoch |
| **Bitcoin Lightning** über selbst gehostetes BTCPay (eigener Node) | Sehr geringe Gebühren, gut geeignet für 2,99 EUR, bessere Privatsphäre als on-chain | Betriebsaufwand für Node und Kanäle; verwahrende Lightning-Dienste sollten vermieden werden |
| **EURC** (Euro-Stablecoin von Circle) in eigenes Wallet | Kein Kursrisiko; laut Anbieter E-Geld-Token unter MiCA, Emittent mit französischer E-Geld-Lizenz ([Circle](https://www.circle.com/eurc)); Ausstieg über EU-CASPs | Käufer brauchen EURC; Transparenz auf der Blockchain; Emittent kann Token einfrieren *(Einschätzung, typisch für Stablecoins)* |
| **USDT** | Verbreitet | In der EU nicht MiCA-konform emittiert; EU-CASPs schränken es ein. **Nicht empfohlen.** |

**Empfehlung *(Einschätzung)*:**
- Bitcoin/Lightning als Hauptweg einsetzen.
- XMR als optionalen Weg für datenschutzbewusste Käufer anbieten, mit dem Bewusstsein, dass XMR-Einnahmen ab 2027 nur über Umwege in Euro tauschbar sind.
- Optional EURC ergänzen.
- Einnahmen in BTC oder EURC lassen sich bei einem im [ESMA-Register](https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica) geführten Anbieter in Euro tauschen.

**Hinweis Google Play:**
- **[Fakt]** Wird die App über Google Play verteilt, müssen In-App-Käufe digitaler Funktionen grundsätzlich über Google Play Billing laufen. Apps dürfen außerhalb der Sonderprogramme nicht auf andere Zahlungswege verweisen ([Google Play Zahlungsrichtlinie](https://support.google.com/googleplay/android-developer/answer/9858738?hl=de)).
- **[Einschätzung]** Bei Verteilung über Google Play kann der Verweis auf eine Onion-Kaufseite gegen diese Richtlinie verstoßen. Das ist kein Gesetzesverstoß, aber ein Sperrrisiko für die App. Bei Verteilung über F-Droid oder als APK stellt sich das Problem nicht.
- **Umsetzung (Okt. 2026):** Die App gibt es jetzt in zwei Varianten (`PLAY_STORE.md`). Die Website-Variante verkauft weiter über den Shop (XMR/BTC). Die Google-Play-Variante (eigene App-ID, eigener Upload-Schlüssel) verkauft die Vollversion **nur** über Google Play Billing und zeigt keinerlei Shop-, Krypto- oder Onion-Hinweise. Beide Varianten bleiben voll miteinander kompatibel.

---

## 5. Steuern in Deutschland

### 5.1 Einkunftsart, Gewerbe

- **[Fakt, Sekundärquelle]** Wer eigene Software-Produkte bzw. Lizenzen standardisiert verkauft, wird in der Regel als **gewerblich** eingeordnet. Freiberuflich (ingenieurähnlich, § 18 EStG) ist eher individuelle, anspruchsvolle Softwareentwicklung für Auftraggeber. Die Abgrenzung ist umstritten ([Existenzgründungsportal des BMWK](https://www.existenzgruendungsportal.de/Redaktion/DE/BMWK-Infopool/Antworten/Gruendungsplanung/Freie-Berufe/beratende-Taetig/Software-Entwickler-und-IT-Berater-freiberufliche-oder-gewerbliche-Taetigkeit.html)).
- **[Einschätzung]** Rechnen Sie mit:
  - **Einkünften aus Gewerbebetrieb** (§ 15 EStG);
  - **Gewerbeanmeldung** (§ 14 GewO) vor dem ersten Verkauf;
  - Gewinnermittlung per **Einnahmenüberschussrechnung** (§ 4 Abs. 3 EStG), solange die Grenzen des § 141 AO (Umsatz 800.000 EUR, Gewinn 80.000 EUR) nicht überschritten sind;
  - **Gewerbesteuer** erst oberhalb des Freibetrags von 24.500 EUR Gewerbeertrag für natürliche Personen (§ 11 Abs. 1 S. 3 Nr. 1 GewStG).
- **[Einschätzung]** Die Kleinunternehmerregelung betrifft **nur die Umsatzsteuer**. Einkommen- und Gewerbesteuer laufen unabhängig davon.

### 5.2 Einnahmen in XMR: Bewertung beim Zufluss

- **[Fakt]** Nach BMF-Schreiben vom 06.03.2025 ([PDF](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-03-06-einzelfragen-kryptowerte-bmf-schreiben.pdf)) gilt:
  - **Rz. 43:** Maßgeblich ist der Marktkurs im Zeitpunkt der Anschaffung. Als Quelle zulässig sind Handelsplattformen oder webbasierte Listen, z. B. CoinMarketCap oder CoinGecko.
  - **Rz. 91:** Auch ein nach dokumentierten Vorgaben einheitlich ermittelter **Tageskurs** wird nicht beanstandet (Tagesdurchschnitts-, Tageszeit- oder Tagesschlusskurs).
  - **Rz. 44:** Bei der EÜR führt der Zugang von Kryptowerten im Rahmen eines tauschähnlichen Vorgangs zu **Betriebseinnahmen**. Kryptowerte gelten als Wirtschaftsgüter im Sinne des **§ 4 Abs. 3 S. 4 EStG**: Ihre Anschaffungskosten werden erst beim Verkauf bzw. der Entnahme als Betriebsausgabe abgezogen. Sie sind in das **laufend zu führende Verzeichnis nach § 4 Abs. 3 S. 5 EStG** aufzunehmen.
- **[Einschätzung]** Rz. 44 steht im Abschnitt zur Blockerstellung. Das Prinzip „Zugang von Kryptowerten = Betriebseinnahme zum Marktwert“ gilt aber für alle Gegenleistungen in Kryptowerten im Betrieb. Für Sie heißt das:
  - Jeder Verkauf ist eine Betriebseinnahme von 2,99 EUR bzw. dem EUR-Wert der erhaltenen XMR beim Zufluss.
  - Die erhaltenen XMR sind Betriebsvermögen mit diesem Wert als Anschaffungskosten.
- **[Einschätzung]** Zur Kursquelle: Ab 2027 wird es kaum noch EU-Börsenkurse für XMR geben. Legen Sie früh eine dokumentierte, gleichbleibende Kursquelle fest, z. B. den Tagesschlusskurs von CoinGecko, und halten Sie sie in der Verfahrensdokumentation fest.

### 5.3 Spätere Kursgewinne und -verluste beim Verkauf der XMR

- **[Fakt]** Rz. 51: Gehören die Kryptowerte zum Betriebsvermögen, sind Veräußerungserlöse Betriebseinnahmen. Abzuziehen sind die individuellen Anschaffungskosten. Lassen sich diese nicht zuordnen, sind Durchschnittswerte zulässig.
- **[Fakt]** Rz. 53: § 23 EStG mit Jahresfrist und Freigrenze 1.000 EUR betrifft **Privatvermögen**.
- **[Einschätzung]** Für Sie gilt daher:
  - Keine Steuerfreiheit nach einem Jahr Haltedauer, keine 1.000-EUR-Freigrenze.
  - Kursgewinne erhöhen, Kursverluste mindern den gewerblichen Gewinn, und zwar im Jahr des Verkaufs (EÜR, § 4 Abs. 3 S. 4 EStG).
  - Auch ein **Tausch XMR→BTC** ist ein Verkauf der XMR mit gleichzeitiger Anschaffung von BTC (BMF Rz. 58 f. zum Tausch).
  - Ratgeber-Aussagen wie „nach einem Jahr steuerfrei“ gelten für Sie nicht.

### 5.4 Umsatzsteuer

- **[Fakt] Kleinunternehmer (seit 01.01.2025):** Steuerfrei sind Ihre Umsätze, wenn der Gesamtumsatz im Vorjahr 25.000 EUR nicht überschritten hat und im laufenden Jahr 100.000 EUR nicht überschreitet ([§ 19 Abs. 1 UStG](https://www.gesetze-im-internet.de/ustg_1980/__19.html)).
- **[Fakt] Krypto als Entgelt:** Die Hingabe von Kryptowerten als Zahlungsmittel ist nicht steuerbar. Der Umtausch in Euro ist nach § 4 Nr. 8 Buchst. b UStG steuerfrei (EuGH C-264/14 *Hedqvist*; BMF-Schreiben vom 27.02.2018, UStAE 4.8.3 Abs. 3a; Fundstelle u. a. [Deubner](https://www.deubner-steuern.de/themen/umsatzsteuer/bitcoin-umsatzsteuer/bmf-schreiben-vom-2722018.html)).
- **[Fakt] Leistungsort digitaler Leistungen an Privatkunden:** Maßgeblich ist der Wohnsitz bzw. gewöhnliche Aufenthalt des Empfängers ([§ 3a Abs. 5 S. 1 und 2 UStG](https://www.gesetze-im-internet.de/ustg_1980/__3a.html)). Davon gibt es eine Ausnahme (S. 3): Der Unternehmer ist nur in einem Mitgliedstaat ansässig, und seine Umsätze an Privatkunden in **anderen EU-Mitgliedstaaten** haben im Vorjahr und im laufenden Jahr insgesamt **10.000 EUR** nicht überschritten. Dann bleibt der Leistungsort Deutschland.
- **[Fakt] Anonyme Käufer:** Nach Art. 24b der [MwSt-Durchführungsverordnung (EU) 282/2011](https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:02011R0282-20220701) gilt Folgendes:
  - Bei Internetleistungen wird der Ort des Kunden anhand von zwei sich nicht widersprechenden Beweismitteln nach Art. 24f bestimmt.
  - Bis 100.000 EUR genügt ein Beweismittel einer an der Leistung beteiligten dritten Person, z. B. eines Zahlungsdienstleisters.
- **[Einschätzung]** Bei Tor und Monero haben Sie **gar kein** solches Beweismittel. Solange die 10.000-EUR-Schwelle nicht überschritten ist, ist das für EU-Kunden unproblematisch, weil der Leistungsort ohnehin Deutschland ist und Sie als Kleinunternehmer keine Umsatzsteuer schulden. Konservativ gerechnet sollten Sie alle Umsätze auf die 10.000 EUR anrechnen. Das entspricht etwa 3.344 Verkäufen à 2,99 EUR, weil Sie nicht wissen, wer im Inland sitzt.
- **[Unsicher]** Zwei Fragen müssen Sie mit dem Steuerberater klären:
  - Käufer in **Drittstaaten**: Für sie gilt die 10.000-EUR-Regel nicht. Der Leistungsort liegt dort, und einzelne Staaten verlangen schon ab dem ersten Umsatz eine Registrierung.
  - Was gilt, sobald die 10.000-EUR-Schwelle überschritten ist (OSS-Registrierung, ausländische Steuersätze, Zusammenspiel mit § 19 und § 19a UStG)?
- **[Fakt] Rechnungen:**
  - Gegenüber Privatpersonen besteht **keine Rechnungspflicht** ([§ 14 Abs. 2 UStG](https://www.gesetze-im-internet.de/ustg_1980/__14.html)).
  - Stellen Sie eine Rechnung aus, genügt als Kleinunternehmer der Mindestinhalt nach [§ 34a UStDV](https://www.gesetze-im-internet.de/ustdv_1980/__34a.html), mit Hinweis auf § 19 UStG. Die Kleinbetragsrechnung nach § 33 UStDV (bis 250 EUR) bleibt unberührt.
  - Ihre interne Rechnungsnummer pro Kauf dient als Beleg für die Buchführung.

### 5.5 Aufzeichnung und Aufbewahrung

- **[Fakt]** Aufzeichnungen müssen einzeln, vollständig, richtig, zeitgerecht und geordnet sein (§ 146 Abs. 1 AO) und dürfen nicht unbemerkt veränderbar sein (§ 146 Abs. 4 AO). Es gelten die GoBD. Wer spezielle Krypto-Software nutzt, muss eine **Verfahrensdokumentation** erstellen (BMF 06.03.2025, Rz. 96–98). In Außenprüfungen besteht ein Datenzugriffsrecht (§ 147 Abs. 6 AO; Rz. 99).
- **[Fakt] Aufbewahrungsfristen** ([§ 147 Abs. 3 AO](https://www.gesetze-im-internet.de/ao_1977/__147.html), aktuelle Fassung):

  | Unterlagen | Frist |
  |---|---|
  | Bücher, Aufzeichnungen | **10 Jahre** |
  | Buchungsbelege | **8 Jahre** (seit der Verkürzung durch das Bürokratieentlastungsgesetz IV) |
  | Sonstige steuerlich bedeutsame Unterlagen | **6 Jahre** |

  Die Annahme „alles 10 Jahre“ ist also nicht ganz genau. **[Einschätzung]** Für Sie ist es am einfachsten, alles 10 Jahre aufzubewahren.
- **[Einschätzung]** Ihr geplantes Schema (Rechnungsnummer, XMR-Betrag, EUR-Kurs, Zeitstempel, Transaktions-ID) ist ein guter Kern. Ergänzen sollten Sie:
  - Kursquelle und Kursart (z. B. CoinGecko, Tagesschlusskurs);
  - empfangende Subadresse;
  - Zahl der Bestätigungen und Zeitpunkt der Freischaltung;
  - Produkt bzw. Lizenz-ID;
  - Unter- oder Überzahlungen;
  - für jeden späteren **Abgang**: Datum, XMR-Menge, Erlös in EUR oder erhaltene BTC/EURC mit Kurs, Gebühren, Gegenpartei bzw. Dienst, Transaktions-ID;
  - das **Verzeichnis nach § 4 Abs. 3 S. 5 EStG** (Bestand je Kryptowert mit Anschaffungskosten);
  - View-Key bzw. Wallet-Exporte als Nachweis.

  Exportieren Sie regelmäßig in ein unveränderbares Format, z. B. signierte bzw. gehashte Monatsexporte.

### 5.6 Was ein Steuerberater konkret prüfen sollte

Siehe die Checkliste am Ende.

---

## 6. Verbraucherrecht (kurz)

- **[Fakt] Widerrufsrecht bei digitalen Inhalten:** Bei digitalen Inhalten, die nicht auf einem körperlichen Datenträger geliefert werden, erlischt das Widerrufsrecht bei kostenpflichtigen Verträgen nur, wenn alle folgenden Voraussetzungen erfüllt sind:
  1. Sie haben mit der Vertragserfüllung begonnen;
  2. der Verbraucher hat **ausdrücklich zugestimmt**, dass Sie vor Ablauf der Widerrufsfrist beginnen;
  3. der Verbraucher hat seine **Kenntnis vom Erlöschen bestätigt**;
  4. Sie haben ihm eine **Bestätigung nach § 312f BGB** auf einem dauerhaften Datenträger zur Verfügung gestellt.

  Quelle: [§ 356 Abs. 6 BGB in der aktuellen Fassung](https://www.gesetze-im-internet.de/bgb/__356.html); ältere Quellen nennen Abs. 5.
- **[Unsicher]** Ohne E-Mail-Adresse des Käufers stellt sich die Frage, wie Sie die Bestätigung auf einem **dauerhaften Datenträger** übermitteln, etwa als herunterladbares PDF zum Speichern. Ob das genügt, sollte ein Anwalt prüfen.
- **[Fakt] Widerrufsbutton seit 19.06.2026:** Nach § 356a BGB müssen Fernabsatzverträge über Online-Oberflächen eine gut sichtbare Widerrufsfunktion haben, und der Eingang des Widerrufs ist auf einem dauerhaften Datenträger zu bestätigen ([Noerr](https://www.noerr.com/de/insights/umsetzungsgesetz-zum-widerrufsbutton-veroeffentlicht)).
- **[Unsicher]** Ob und wie lange der Button nötig ist, wenn das Widerrufsrecht sofort mit der Freischaltung erlischt, und wie die Bestätigung ohne Kontaktdaten gelingt, ist offen.
- **[Fakt] Informationspflichten:**
  - Vorvertragliche Informationen nach § 312d BGB in Verbindung mit Art. 246a EGBGB, darunter Identität und **Anschrift** des Unternehmers, Preis, Funktionsweise und Kompatibilität der digitalen Inhalte und Widerrufsbelehrung.
  - Bestell-Button mit „zahlungspflichtig bestellen“ oder einer eindeutigen Entsprechung (§ 312j Abs. 3 BGB).
  - Gewährleistung und **Aktualisierungspflicht** für digitale Produkte (§§ 327 ff., insbesondere § 327f BGB). Das ist für eine Sicherheits-App relevant: Sicherheitsupdates werden für einen angemessenen Zeitraum geschuldet.
- **[Fakt] Impressum:**
  - [§ 5 DDG](https://www.gesetze-im-internet.de/ddg/__5.html) verpflichtet Anbieter geschäftsmäßiger, in der Regel entgeltlicher digitaler Dienste zu Angaben wie Name, Anschrift, E-Mail und gegebenenfalls USt-IdNr. bzw. Wirtschafts-IdNr.
  - Eine Ausnahme für Tor- bzw. Onion-Dienste enthält das Gesetz nicht.
- **[Einschätzung]**
  - Eine Onion-Verkaufsseite ist ein solcher digitaler Dienst, das Impressum ist also Pflicht.
  - Als Verkäufer bleiben Sie damit **nicht anonym**.
  - Hinzu kommt eine Datenschutzerklärung nach Art. 13 DSGVO, soweit Sie personenbezogene Daten verarbeiten.
  - Ein Hinweis auf die OS-Plattform der EU ist nach meinem Kenntnisstand seit Abschaffung der ODR-Plattform (Juli 2025) nicht mehr nötig. **[Unsicher, bitte gegenprüfen]**

---

## Fragen für den Steuerberater / Anwalt (Checkliste)

**Steuerberater**
- [ ] Ist der Verkauf der App-Vollversion gewerblich oder freiberuflich? Ab wann ist eine Gewerbeanmeldung nötig? Wie ist es bei geringen Umsätzen oder anfänglichen Verlusten (Liebhaberei)?
- [ ] EÜR mit Kryptowerten: Wie bewerte ich Einnahmen in XMR und BTC beim Zufluss? Welche Kursquelle und welchen Tageskurs (BMF Rz. 43, 91) soll ich festlegen? Wie führe ich das Verzeichnis nach § 4 Abs. 3 S. 5 EStG?
- [ ] Welche Verbrauchsfolge (FiFo oder Durchschnitt) und welche Behandlung gelten beim Tausch XMR→BTC→EUR (Rz. 51, 58 f.)?
- [ ] Umsatzsteuer: Wie lege ich den Leistungsort fest, wenn die Käufer völlig anonym sind? Was gilt für Käufer in Drittstaaten? Wie zähle ich die 10.000-EUR-Schwelle nach § 3a Abs. 5 S. 3 UStG? Was passiert beim Überschreiten (OSS, § 19a UStG)?
- [ ] Fließen der Umtausch von XMR in EUR (steuerfrei nach § 4 Nr. 8 b UStG) oder andere Hilfsumsätze in den Gesamtumsatz nach § 19 Abs. 2 UStG ein?
- [ ] Brauche ich Rechnungen bzw. Eigenbelege, und mit welchem Inhalt (§ 14 UStG, §§ 33, 34a UStDV)? Ist mein Aufzeichnungsschema GoBD-konform? Brauche ich eine Verfahrensdokumentation?
- [ ] Wie lange und in welcher Form bewahre ich Wallet-Exporte, View-Keys und Kursdaten auf (§ 147 AO: 10, 8 oder 6 Jahre)?
- [ ] Welcher Nachweis der Mittelherkunft ist für die Bank sinnvoll, wenn ich XMR, BTC oder EURC in EUR tausche?

**Anwalt (Bank-, Aufsichts-, IT- und Verbraucherrecht)**
- [ ] Bestätigung: Bin ich als Händler, der XMR in ein eigenes Wallet annimmt, von Art. 79 AMLR, MiCA und GwG nicht erfasst? Gilt das auch nach dem 10.07.2027?
- [ ] Ab wann würden regelmäßige P2P-Verkäufe eigener XMR gegen EUR zu einer erlaubnispflichtigen Krypto-Dienstleistung (Art. 3 Abs. 1 Nr. 19, Art. 59 MiCA)?
- [ ] Welches Risiko besteht bei Nutzung nicht zugelassener Swap- oder Gateway-Dienste, auch mit Blick auf § 261 StGB?
- [ ] Impressum nach § 5 DDG auf der Onion-Seite: Ist eine ladungsfähige Anschrift über einen Dienstleister (c/o) zulässig?
- [ ] Widerrufsrecht: Wie setze ich § 356 Abs. 6 BGB, die Bestätigung nach § 312f BGB und den Widerrufsbutton nach § 356a BGB ohne Kontaktdaten des Käufers um?
- [ ] AGB, Lizenzbedingungen, Gewährleistung und Aktualisierungspflicht (§§ 327 ff. BGB) für eine Sicherheits-App.
- [ ] *(Nicht recherchiert, aber prüfenswert)* Exportkontrolle und Sanktionen für Verschlüsselungssoftware an weltweit anonyme Käufer (Dual-Use-VO (EU) 2021/821, Kategorie 5 Teil 2 mit Massenmarkt-Ausnahme; Russland-Sanktionen VO (EU) 833/2014).
- [x] Verteilung der App: Bei Google Play die Zahlungsrichtlinie beachten (Verweis auf externe Zahlung). Gelöst durch eine eigene Play-Variante mit Google Play Billing, siehe `PLAY_STORE.md`.

---

## Was ich nicht abschließend prüfen konnte

- Registereintrag „1PayCX UAB“ (Firmencode 304592831) im litauischen Handelsregister: nicht geprüft. Die Angaben stammen ausschließlich aus dem Code der Website.
- Ob NOWPayments XMR aktuell unterstützt und wie die genauen Gebühren für die Fiat-Auszahlung aussehen: Die Preisseite war nicht eindeutig.
- AMLA-Leitlinien zu Art. 40 bzw. Art. 79 AMLR: bis 16.10.2026 nicht gefunden.
- Vollständige Liste der EU-Anbieter mit XMR: Das ESMA-Register weist keine einzelnen Assets aus. Der Stand Oktober 2026 beruht auf einer Sekundärquelle (cryptoticker.io).
- Steuerliche Behandlung von Kunden in Drittstaaten bei völliger Anonymität: Dafür fehlt eine Verwaltungsanweisung.

## Quellenverzeichnis (Auswahl, abgerufen 15./16.10.2026)

**EU-Recht (Primärquellen)**
- Verordnung (EU) 2024/1624 (AMLR), Art. 2, 3, 40, 79, 80, 90, Erwägungsgrund 160: https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32024R1624
- Verordnung (EU) 2023/1114 (MiCA), Art. 3, 59, 61, 76, 143: https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32023R1114
- Verordnung (EU) 2023/1113 (Geldtransfer / Travel Rule), Art. 2, 3 Nr. 20, 16, 17: https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32023R1113
- Richtlinie (EU) 2023/2226 (DAC8): https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:32023L2226
- Durchführungsverordnung (EU) 282/2011, Art. 24b: https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:02011R0282-20220701

**ESMA**
- Interim-MiCA-Register: https://www.esma.europa.eu/sites/default/files/2024-12/CASPS.csv und https://www.esma.europa.eu/sites/default/files/2024-12/NCASP.csv
- Leitlinien Reverse Solicitation (DE): https://www.esma.europa.eu/sites/default/files/2025-02/ESMA35-1872330276-2030_Guidelines_on_reverse_solicitation_under_MiCA_DE.pdf
- Public Statement zum Ende der Übergangsfrist (Juni 2026): https://www.esma.europa.eu/sites/default/files/2026-06/ESMA75-113276571-1710_Public_Statement_MiCA_transitional_period_ends.pdf

**Deutsches Recht und Verwaltung**
- § 147 AO: https://www.gesetze-im-internet.de/ao_1977/__147.html
- § 19 UStG: https://www.gesetze-im-internet.de/ustg_1980/__19.html
- § 3a UStG: https://www.gesetze-im-internet.de/ustg_1980/__3a.html
- § 14 UStG: https://www.gesetze-im-internet.de/ustg_1980/__14.html
- § 34a UStDV: https://www.gesetze-im-internet.de/ustdv_1980/__34a.html
- § 10 GwG: https://www.gesetze-im-internet.de/gwg_2017/__10.html
- § 261 StGB: https://www.gesetze-im-internet.de/stgb/__261.html
- § 356 BGB: https://www.gesetze-im-internet.de/bgb/__356.html
- § 5 DDG: https://www.gesetze-im-internet.de/ddg/__5.html
- BMF-Schreiben vom 06.03.2025 (Kryptowerte, Ertragsteuer): https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-03-06-einzelfragen-kryptowerte-bmf-schreiben.pdf
- BMF-Schreiben vom 27.02.2018 (Umsatzsteuer, Bitcoin), Fundstelle: https://www.deubner-steuern.de/themen/umsatzsteuer/bitcoin-umsatzsteuer/bmf-schreiben-vom-2722018.html

**Anbieter**
- NOWPayments AGB (FD Transfers LLC, Stand 31.08.2026): https://nowpayments.io/doc/fd-tos.pdf
- NOWPayments, Über uns: https://nowpayments.io/help/about-nowpayments
- 1pay.cx Startseite: https://1pay.cx/
- 1pay.cx AGB: https://1pay.cx/terms
- XMR Checkout: https://xmrcheckout.com/ und https://github.com/xmrcheckout/xmrcheckout
- MoneroPay: https://moneropay.eu/
- BTCPay Monero-Plugin: https://github.com/btcpay-monero/btcpayserver-monero-plugin
- Kraken Support (XMR im EWR): https://support.kraken.com/hc/articles/support-for-monero-xmr-in-europe
- Circle EURC: https://www.circle.com/eurc
- Google Play Zahlungsrichtlinie: https://support.google.com/googleplay/android-developer/answer/9858738?hl=de

**Sekundärquellen**
- cryptoticker.io, Stand der Börsen am 05.10.2026: https://cryptoticker.io/de/monero-kaufen-delisting/
- The Block (Binance-Delisting 2024): https://www.theblock.co/post/276176/binance-delisting-monero
- Cointelegraph (Kraken EWR): https://cointelegraph.com/news/kraken-ends-monero-support-european-economic-area
- WINHELLER (Bankpraxis bei Krypto-Zuflüssen): https://winheller.com/blog/kontosperre-bankkuendigung-kryptovermoegen/
- Noerr (§ 356a BGB): https://www.noerr.com/de/insights/umsetzungsgesetz-zum-widerrufsbutton-veroeffentlicht
- Haufe (KStTG / DAC8): https://www.haufe.de/id/beitrag/steuerliche-informationspflicht-fuer-anbieter-von-kryptowerte-dienstleistungen-HI17067328.html
- Existenzgründungsportal BMWK (Software, gewerblich oder freiberuflich): https://www.existenzgruendungsportal.de/Redaktion/DE/BMWK-Infopool/Antworten/Gruendungsplanung/Freie-Berufe/beratende-Taetig/Software-Entwickler-und-IT-Berater-freiberufliche-oder-gewerbliche-Taetigkeit.html
