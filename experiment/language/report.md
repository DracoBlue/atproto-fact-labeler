# Language detection — library comparison

Sample: first 100 `claim_review` rows from the local index.

## Per-detector summary

| detector | undefined % | mean latency µs/call | total calls |
| --- | ---: | ---: | ---: |
| franc-min | 14 % | 115 µs | 100 |
| franc-all | 31 % | 227 µs | 100 |
| tinyld | 0 % | 181 µs | 100 |
| eld | 0 % | 51 µs | 100 |

## Pair-wise agreement

Percentage of rows where two detectors return the *same* non-undefined code.

| pair | agreement |
| --- | ---: |
| franc-min ↔ franc-all | 98.6 % |
| franc-min ↔ tinyld | 96.5 % |
| franc-min ↔ eld | 98.8 % |
| franc-all ↔ tinyld | 95.7 % |
| franc-all ↔ eld | 97.1 % |
| tinyld ↔ eld | 97 % |

## Top languages reported

### franc-min

| code | count |
| --- | ---: |
| en | 36 |
| ta | 23 |
| fa | 21 |
| ? | 14 |
| te | 4 |
| de | 1 |
| pt | 1 |

### franc-all

| code | count |
| --- | ---: |
| en | 33 |
| ? | 31 |
| ta | 23 |
| fa | 6 |
| te | 4 |
| ca | 1 |
| de | 1 |
| pt | 1 |

### tinyld

| code | count |
| --- | ---: |
| en | 36 |
| ta | 23 |
| fa | 22 |
| ar | 12 |
| te | 4 |
| ga | 2 |
| de | 1 |

### eld

| code | count |
| --- | ---: |
| en | 38 |
| ta | 23 |
| fa | 21 |
| ar | 12 |
| te | 4 |
| de | 1 |
| ms | 1 |

## Per-row results

Only shows rows where the four detectors disagree, plus the URL/publisher for ground-truth eyeballing.

| id | stored | franc-min | franc-all | tinyld | eld | text | publisher | url |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | – | fa | ? | fa | fa | ویدیوی شلیک به بالگرد آپاچی آمریکایی با یک دوش‌پرتابه | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-16-ai-generated-video-us-apache-crash-near-hormuz |
| 6 | – | fa | ? | fa | fa | ویدیویی از کشتی دیشا در حال گذر از تنگه هرمز پس از توافق | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-15-iran-us-agreement-tanker-video |
| 7 | – | fa | ? | fa | fa | ویدیوی شلیک پلیس به مخالفان توافق، در تجمع شبانه هواداران حکومت | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-15-iran-baghdad-protest-video-falsely-linked |
| 11 | – | fa | ? | fa | fa | آناتومی یک سقوط؛ از سانحه بالگرد آپاچی نزدیک سواحل عمان چه می‌دانیم؟ | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-12-apache-crash-oman-possible-scenarios |
| 12 | – | fa | ? | fa | fa | ویدیوی منتسب به حمله آمریکا به جنوب ایران در بامداد ۲۰ خرداد | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-12-old-video-us-attack-southern-iran |
| 13 | – | fa | ? | fa | fa | ویدیوی معرفی تیم ملی ایران در افتتاحیه جام جهانی با نمادهایی از تخت جمشید و دما… | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-12-iran-team-fifa-world-cup-opening-ceremony-ai-generated |
| 14 | – | fa | ? | fa | fa | درباره کشف موی قاچاق از ایران در ارمنستان چه می‌دانیم؟ | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-11-armenia-smuggled-hair-iran-protest-victims |
| 15 | – | fa | ? | fa | fa | ادعای توقیف یک کشتی آمریکایی به نام آریستا در تنگه هرمز | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-11-iran-false-claim-arista-us-ship-seizure-hormuz |
| 16 | – | fa | ? | fa | fa | ادعای منتسب به مهدی تاج درباره اینکه کادر فنی تیم ملی فوتبال به دلیل مناسب‌تر ب… | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-11-iran-mehdi-taj-mexico-visa-world-cup-2026 |
| 17 | in | en | ca | en | en | Video shows the members of the Cockroach Janta Party driving away certain media… | FACTLY | https://factly.in/an-old-video-related-to-ugc-protests-is-being-falsely-shared-as-it-is-related-to-cjp-protests/ |
| 23 | in | en | en | ga | en | A Navbharat Times graphic quotes Prime Minister Narendra Modi as appealing to w… | FACTLY | https://factly.in/this-viral-navbharat-times-graphic-alleging-that-pm-modi-urged-women-to-sell-their-gold-and-deposit-the-money-in-banks-is-fake/ |
| 27 | – | fa | ? | fa | fa | در جریان جنگ ۴۰ روزه، اسرائیل بیش از ۲۰۰۰ کشته و آمریکا بیش از ۱۰۰۰ کشته داده ا… | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-10-casaulties-us-israel-attack-iran |
| 29 | – | fa | ? | fa | fa | سرنگونی سه جنگنده اف۱۵ آمریکا با پدافند خودی، به دلیل حمله هوایی اف۵ ایرانی بود… | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-10-IRIAF-F5-F15E-USAF-KUWAIT-EPICFURY |
| 30 | – | fa | ? | fa | fa | ویدیوی منتسب به حمله موشکی ایران به «نقب» در اسرائیل | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-09-iran-viral-fire-video-philippines-not-israel |
| 31 | – | fa | ? | fa | fa | ادعای جدید بودن یک ویدیو بر اثر حملات اخیر به اسرائیل | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-09-iran-missile-attack-tel-aviv |
| 33 | – | ? | ? | ga | ms | Sri Lankan PM Harini, Honouring Vaibhav Sooryavanshi? | Factcrescendo Sri Lanka | https://srilanka.factcrescendo.com/english/fake-image-claims-vaibhav-suryavanshi-was-honored-by-sri-lankan-prime-minister-harini-amarasuriya/ |
| 35 | – | ? | ? | ar | ar | فوضى عارمة في ساحة مطار الريان ومحاولات لاقتحامه ونهبه وفرار القوات من محيطه | المشاهد نت | https://almushahid.net/140425/ |
| 36 | – | ? | ? | ar | ar | موظف في منتزه "عين الفوارة يصور العائلات في الحمام | المشاهد نت | https://almushahid.net/140292/ |
| 38 | in | en | ? | en | en | The video shows a Muslim imam in Bangladesh chaining a Hindu woman and forcibly… | FACTLY | https://factly.in/a-video-of-three-muslim-women-being-assaulted-over-theft-allegations-in-bangladesh- |
| 56 | – | fa | ? | fa | fa | ویدیوی برخورد موشک ایران به برج موشه‌آویو در تلاویو | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-08-iran-missile-claim-moshe-aviv |
| 57 | – | ? | ? | ar | ar | قيام عناصر مسلحة تابعة لحركة أنصار الله (الحوثيين) بسحل عدد من النساء واقتيادهن… | ARIJ | https://arij.net/chatbot-fact/the-circulating-video-of-women-being-dragged-by-the-houthis-in-yemen-is-old-and-does-not-document-the-alleged-incident/ |
| 58 | – | ? | ? | ar | ar | ظاهرة إضاءة غريبة في السماء تم تسجيلها، بعض الشهود يقولون إنه قد يكون تقنيات اي… | ARIJ | https://arij.net/chatbot-fact/the-circulating-video-of-a-strange-light-appearing-in-the-sky-has-nothing-to-do-with-advanced-iranian-technology-it-is-ai-generated/ |
| 59 | – | ? | ? | ar | ar | قبل صعودهم إلى طائرة الرئاسة الأمريكية “إير فورس وان” لمغادرة بكين، تخلّص أعضاء… | ARIJ | https://arij.net/chatbot-fact/the-circulating-image-of-the-us-delegation-disposing-of-chinese-gifts-is-ai-generated/ |
| 60 | – | ? | ? | ar | ar | ضاحي خلفان نائب رئيس شرطة دبي طلب اللجوء السياسي في بريطانيا وغادر الإمارات | ARIJ | https://arij.net/chatbot-fact/reports-of-dhahi-khalfan-leaving-the-uae-and-seeking-asylum-in-the-uk-are-unverified/ |
| 61 | – | ? | ? | ar | ar | بدء العمل بنظام اتصالات جديد يتضمن تسجيل المكالمات والمحادثات ومراقبة تطبيقات ا… | ARIJ | https://arij.net/chatbot-fact/the-sudanese-ministry-of-interior-has-not-announced-a-new-communications-system/ |
| 62 | – | ? | ? | ar | ar | الجيش الإسرائيلي (IDF) يأسر وحدة حزب الله المسؤولة عن الكمين الذي قتل اثنين من … | ARIJ | https://arij.net/chatbot-fact/there-is-no-evidence-for-the-claims-that-israeli-forces-arrested-hezbollah-members-following-the-death-of-a-french-soldier-in-southern-lebanon/ |
| 63 | – | ? | ? | ar | ar | CIA ينفي انطلاق المسيّرات التي استهدفت السودان من الأراضي الإثيوبية | ARIJ | https://arij.net/chatbot-fact/there-is-no-truth-to-the-cias-statements-regarding-the-launch-of-drones-from-ethiopia-that-attacked-khartoum-airport/ |
| 64 | – | ? | ? | ar | ar | كمين لحزب الله يستهدف وحدة عسكرية إسرائيلية | ARIJ | https://arij.net/chatbot-fact/the-video-is-targeting-russian-soldiers-in-ukraine-and-not-israeli-soldiers-in-lebanon/ |
| 65 | – | ? | ? | ar | ar | رئيسة وزراء إيطاليا ترفض مصافحة نتنياهو | ARIJ | https://arij.net/chatbot-fact/the-video-of-meloni-slapping-netanyahu-is-ai-generated/ |
| 66 | – | ? | ? | ar | ar | جنود إسرائيليون أسرهم حزب الله | ARIJ | https://arij.net/chatbot-fact/the-video-of-hezbollah-capturing-two-israeli-soldiers-is-ai-generated/ |
| 69 | – | fa | ? | fa | fa | ویدیوی منتسب به ورود نیروهای آمریکایی به خاک ایران برای نجات خلبان آمریکایی | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-08-fake-video-american-commandos-in-iran |
| 75 | in | en | ? | fa | en | Thalapathy Loyola Collage Student identity card 1996
#thalapathy #loyolacampus … | youturn | https://en.youturn.in/factcheck/fact-check-cm-vijay-loyola-college-fake-id-card.html |
| 88 | in | pt | pt | en | en | A Direct Way to Register Public Complaints | youturn | https://youturn.in/factcheck/complaints-submitted-directly-cm-vijay-helpline-number-1100-is-old.html |
| 104 | in | ? | ? | en | en | Next banger

@TVKVijayHQ na - Ella ball um sixer ah parakuthe. 

Super na. Huge… | youturn | https://youturn.in/factcheck/free-coaching-competitive-examinations-only-under-the-tvk-regime-false.html |

## All rows

| id | stored | franc-min | franc-all | tinyld | eld | text | publisher | url |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | – | fa | fa | fa | fa | ویدیوی پریدن زن بدون لباس در زمین بازی قطر و سوئیس | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-16-ai-video-qatar-switzerland-pitch-invader |
| 2 | – | fa | ? | fa | fa | ویدیوی شلیک به بالگرد آپاچی آمریکایی با یک دوش‌پرتابه | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-16-ai-generated-video-us-apache-crash-near-hormuz |
| 3 | in | en | en | en | en | The video depicts a ship carrying Indian nationals that was attacked by the Uni… | FACTLY | https://factly.in/an-old-video-of-an-oil-tanker-skylight-falsely-linked-to-the-june-2026-settebello-attack/ |
| 4 | in | en | en | en | en | The video shows a Maulana molesting a schoolgirl in broad daylight in Bareilly,… | FACTLY | https://factly.in/this-viral-video-does-not-show-a-maulana-molesting-a-schoolgirl-in-bareilly-u-p-it-is-from-bangladesh/ |
| 5 | in | te | te | te | te | 14 జూన్ 2026న బ్రెజిల్‌లోని రియో డి జనీరోలో రెండు హెలికాప్టర్లు గాలిలో ఢీకొన్న … | FACTLY | https://factly.in/telugu-an-unrelated-old-video-from-malaysia-is-being-shared-with-the-claim-that-two-helicopters-collided-in-mid-air-in-brazil/ |
| 6 | – | fa | ? | fa | fa | ویدیویی از کشتی دیشا در حال گذر از تنگه هرمز پس از توافق | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-15-iran-us-agreement-tanker-video |
| 7 | – | fa | ? | fa | fa | ویدیوی شلیک پلیس به مخالفان توافق، در تجمع شبانه هواداران حکومت | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-15-iran-baghdad-protest-video-falsely-linked |
| 8 | in | te | te | te | te | నాగ్‌పుర్‌లోని RSS ప్రధాన కార్యాలయంలో మారణాయుధాలు దొరికినట్లు పోలీసులు చెప్పారు. | FACTLY | https://factly.in/telugu-there-is-no-truth-in-the-propaganda-that-deadly-weapons-were-found-at-the-rss-headquarters-in-nagpur/ |
| 9 | in | en | en | en | en | Video shows police officers parading and thrashing three Muslim youths for eve-… | FACTLY | https://factly.in/this-video-does-not-show-muslim-youths-being-paraded-for-eve-teasing/ |
| 11 | – | fa | ? | fa | fa | آناتومی یک سقوط؛ از سانحه بالگرد آپاچی نزدیک سواحل عمان چه می‌دانیم؟ | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-12-apache-crash-oman-possible-scenarios |
| 12 | – | fa | ? | fa | fa | ویدیوی منتسب به حمله آمریکا به جنوب ایران در بامداد ۲۰ خرداد | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-12-old-video-us-attack-southern-iran |
| 13 | – | fa | ? | fa | fa | ویدیوی معرفی تیم ملی ایران در افتتاحیه جام جهانی با نمادهایی از تخت جمشید و دما… | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-12-iran-team-fifa-world-cup-opening-ceremony-ai-generated |
| 14 | – | fa | ? | fa | fa | درباره کشف موی قاچاق از ایران در ارمنستان چه می‌دانیم؟ | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-11-armenia-smuggled-hair-iran-protest-victims |
| 15 | – | fa | ? | fa | fa | ادعای توقیف یک کشتی آمریکایی به نام آریستا در تنگه هرمز | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-11-iran-false-claim-arista-us-ship-seizure-hormuz |
| 16 | – | fa | ? | fa | fa | ادعای منتسب به مهدی تاج درباره اینکه کادر فنی تیم ملی فوتبال به دلیل مناسب‌تر ب… | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-11-iran-mehdi-taj-mexico-visa-world-cup-2026 |
| 17 | in | en | ca | en | en | Video shows the members of the Cockroach Janta Party driving away certain media… | FACTLY | https://factly.in/an-old-video-related-to-ugc-protests-is-being-falsely-shared-as-it-is-related-to-cjp-protests/ |
| 18 | in | en | en | en | en | A Navbharat Times graphic quotes PM Modi discussing his father’s death in the 1… | FACTLY | https://factly.in/this-viral-navbharat-times-graphic-alleging-that-pm-modi-discussed-his-fathers-death-in-the-133rd-episode-of-the-mann-ki-baat-is-fake/ |
| 19 | de | de | de | de | de | Deutschland bezahlt mit seinem Hilfsgeld eine Rentenerhöhung in der Ukraine. | BR24 #Faktenfuchs | https://www.br.de/nachrichten/deutschland-welt/deutsche-hilfsgelder-fuer-ukrainische-renten-faktenfuchs,VMEcFPK |
| 22 | in | te | te | te | te | ఫ్రాన్స్‌లో ముస్లింల రాళ్ళ దాడి నుండి తప్పించుకోడానికి షీల్డ్‌లు అడ్డం పెట్టుకు… | FACTLY | https://factly.in/telugu-2025-video-of-indonesian-protests-being-shared-incorrectly-as-muslims-throwing-stones-at-police-in-france/ |
| 23 | in | en | en | ga | en | A Navbharat Times graphic quotes Prime Minister Narendra Modi as appealing to w… | FACTLY | https://factly.in/this-viral-navbharat-times-graphic-alleging-that-pm-modi-urged-women-to-sell-their-gold-and-deposit-the-money-in-banks-is-fake/ |
| 24 | in | en | en | en | en | Video shows Lieutenant Colonel Karnail Singh being assaulted in Kerala after he… | FACTLY | https://factly.in/old-video-of-attack-on-army-officer-in-kerala-falsely-linked-to-harassment-of-a-minor-girl/ |
| 25 | in | en | en | en | en | The video shows a Muslim youth being beaten with belts by Hindutva supporters. | FACTLY | https://factly.in/this-viral-video-does-not-show-a-muslim-youth-being-beaten-by-hindutva-supporters-both-parties-involved-are-hindus/ |
| 26 | – | en | en | en | en | Netanyahu personally requested that Yamal not be allowed into the United States… | FactCrescendo Sri Lanka | https://srilanka.factcrescendo.com/english/fact-check-lamine-yamal-us-visa-ban/ |
| 27 | – | fa | ? | fa | fa | در جریان جنگ ۴۰ روزه، اسرائیل بیش از ۲۰۰۰ کشته و آمریکا بیش از ۱۰۰۰ کشته داده ا… | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-10-casaulties-us-israel-attack-iran |
| 28 | – | fa | fa | fa | fa | تصویر زنی با «لباس نامتعارف» در تجمعات شبانه حکومتی | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-10-iran-woman-night-gatherings-ai |
| 29 | – | fa | ? | fa | fa | سرنگونی سه جنگنده اف۱۵ آمریکا با پدافند خودی، به دلیل حمله هوایی اف۵ ایرانی بود… | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-10-IRIAF-F5-F15E-USAF-KUWAIT-EPICFURY |
| 30 | – | fa | ? | fa | fa | ویدیوی منتسب به حمله موشکی ایران به «نقب» در اسرائیل | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-09-iran-viral-fire-video-philippines-not-israel |
| 31 | – | fa | ? | fa | fa | ادعای جدید بودن یک ویدیو بر اثر حملات اخیر به اسرائیل | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-09-iran-missile-attack-tel-aviv |
| 32 | – | fa | fa | fa | fa | تورم غذا در اردیبهشت ۱۴۰۵؛ هزینه سبد کالابرگ خانوار از ۱۶ میلیون تومان گذشت | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-09-iran-food-inflation-05-2026 |
| 33 | – | ? | ? | ga | ms | Sri Lankan PM Harini, Honouring Vaibhav Sooryavanshi? | Factcrescendo Sri Lanka | https://srilanka.factcrescendo.com/english/fake-image-claims-vaibhav-suryavanshi-was-honored-by-sri-lankan-prime-minister-harini-amarasuriya/ |
| 35 | – | ? | ? | ar | ar | فوضى عارمة في ساحة مطار الريان ومحاولات لاقتحامه ونهبه وفرار القوات من محيطه | المشاهد نت | https://almushahid.net/140425/ |
| 36 | – | ? | ? | ar | ar | موظف في منتزه "عين الفوارة يصور العائلات في الحمام | المشاهد نت | https://almushahid.net/140292/ |
| 37 | – | en | en | en | en | Police Have Issued a Warning About Keychains Allegedly Containing Tracking Chip… | Fact Crescendo Sri Lanka | https://srilanka.factcrescendo.com/english/police-have-not-issued-a-warning-about-keyrings-allegedly-containing-tracking-chips/ |
| 38 | in | en | ? | en | en | The video shows a Muslim imam in Bangladesh chaining a Hindu woman and forcibly… | FACTLY | https://factly.in/a-video-of-three-muslim-women-being-assaulted-over-theft-allegations-in-bangladesh- |
| 39 | in | en | en | en | en | Video shows a Korean man dressed as a pregnant woman being harassed by a group … | FACTLY | https://factly.in/there-is-no-truth-to-the-claims-circulating-that-young-men-harassed-a-korean-man-who-was-dressed-as-a-pregnant-woman-in-india/ |
| 40 | in | en | en | en | en | The wave is real. It has sustained till elections. I also was one among those w… | youturn | https://en.youturn.in/factcheck/fact-check-fake-frontline-magazine-vijay-wave-tvk-2026-elections.html |
| 41 | in | en | en | en | en | Mother... a word in which the entire world resides...

The tragic incident in J… | youturn | https://en.youturn.in/factcheck/ai-generated-image-jabalpur-cruise-accident-fact-check.html |
| 42 | in | en | en | en | en | A Bangladeshi jihadi was giving false advice to Hindu girls at Delhi University… | youturn | https://en.youturn.in/factcheck/false-claim-bangladesh-video-viral-as-delhi-university-love-jihad.html |
| 43 | in | en | en | en | en | TVK Chief Vijay holding a photo of Jesus in his victory road show after winning… | youturn | https://en.youturn.in/factcheck/fact-check-vijay-jesus-image-tvk-victory-rally-old-video.html |
| 44 | in | en | en | en | en | Following the triumphant victory of the BJP in the West Bengal elections, a pro… | youturn | https://en.youturn.in/factcheck/fact-check-viral-video-bangladeshis-leaving-beng-albiswa-ijtema.html |
| 45 | in | en | en | en | en | TVK MLA Keerthana rhetorically questioned how many people or previous governmen… | youturn | https://en.youturn.in/factcheck/fact-check-tvk-white-paper-history-tamil-nadu-2026.html |
| 46 | in | en | en | en | en | Bit late, but she made sure she is there at her hubbies big day event by attend… | youturn | https://en.youturn.in/factcheck/fact-check-vijay-wife-tvk-event-sangeetha-krish.html |
| 47 | in | en | en | en | en | Good initiative taken immediately by 
CM Vijay 🔥🔥 | youturn | https://en.youturn.in/factcheck/fact-check-cm-vijay-police-patrol-vehicles-old-video.html |
| 48 | in | en | en | en | en | A newspaper clipping from 1967 shows a front page of The Hindu with the headlin… | youturn | https://en.youturn.in/factcheck/fact-check-indira-gandhi-gold-hindu-fake-clipping.html |
| 49 | in | en | en | en | en | Anti-Hindi Hate started in TamilNadu after Swearing-in of TVK Vijay.

This is t… | youturn | https://en.youturn.in/factcheck/fact-check-anti-hindi-protest-video-vijay-cm-2026.html |
| 50 | in | en | en | en | en | Mamata Banerjee's first video after losing the West Bengal elections | youturn | https://en.youturn.in/factcheck/fact-check-mamata-banerjee-old-injury-video-2021-shared-as-recent.html |
| 51 | in | en | en | en | en | Finally, the film-obsessed Hindus of Tamil Nadu are waking up after the “Sanata… | youturn | https://en.youturn.in/factcheck/fact-check-tvk-protest-video-falsely-linked-sanatana-dharma-row.html |
| 52 | in | en | en | en | en | For the first time since Independence, a Dalit leader has been appointed as Edu… | youturn | https://en.youturn.in/factcheck/fact-check-rajmohan-first-dalit-education-minister-tamil-nadu-false.html |
| 53 | in | en | en | en | en | Good news for TN citizens! 

Now we can directly submit our Complaints to our C… | youturn | https://en.youturn.in/factcheck/fact-check-cm-vijay-helpline-portal-not-new-initiative.html |
| 54 | in | en | en | en | en | The days of waiting for a convoy are over. For the first time, our traffic kept… | youturn | https://en.youturn.in/factcheck/fact-check-cm-vijay-convoy-traffic-policy-not-first-time.html |
| 55 | in | en | en | en | en | Tamil Nadu CM Thalapathy Vijay skips luxury, carries home food to office, his s… | youturn | https://en.youturn.in/factcheck/fact-check-cm-vijay-tiffin-office-ai-generated-image.html |
| 56 | – | fa | ? | fa | fa | ویدیوی برخورد موشک ایران به برج موشه‌آویو در تلاویو | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-08-iran-missile-claim-moshe-aviv |
| 57 | – | ? | ? | ar | ar | قيام عناصر مسلحة تابعة لحركة أنصار الله (الحوثيين) بسحل عدد من النساء واقتيادهن… | ARIJ | https://arij.net/chatbot-fact/the-circulating-video-of-women-being-dragged-by-the-houthis-in-yemen-is-old-and-does-not-document-the-alleged-incident/ |
| 58 | – | ? | ? | ar | ar | ظاهرة إضاءة غريبة في السماء تم تسجيلها، بعض الشهود يقولون إنه قد يكون تقنيات اي… | ARIJ | https://arij.net/chatbot-fact/the-circulating-video-of-a-strange-light-appearing-in-the-sky-has-nothing-to-do-with-advanced-iranian-technology-it-is-ai-generated/ |
| 59 | – | ? | ? | ar | ar | قبل صعودهم إلى طائرة الرئاسة الأمريكية “إير فورس وان” لمغادرة بكين، تخلّص أعضاء… | ARIJ | https://arij.net/chatbot-fact/the-circulating-image-of-the-us-delegation-disposing-of-chinese-gifts-is-ai-generated/ |
| 60 | – | ? | ? | ar | ar | ضاحي خلفان نائب رئيس شرطة دبي طلب اللجوء السياسي في بريطانيا وغادر الإمارات | ARIJ | https://arij.net/chatbot-fact/reports-of-dhahi-khalfan-leaving-the-uae-and-seeking-asylum-in-the-uk-are-unverified/ |
| 61 | – | ? | ? | ar | ar | بدء العمل بنظام اتصالات جديد يتضمن تسجيل المكالمات والمحادثات ومراقبة تطبيقات ا… | ARIJ | https://arij.net/chatbot-fact/the-sudanese-ministry-of-interior-has-not-announced-a-new-communications-system/ |
| 62 | – | ? | ? | ar | ar | الجيش الإسرائيلي (IDF) يأسر وحدة حزب الله المسؤولة عن الكمين الذي قتل اثنين من … | ARIJ | https://arij.net/chatbot-fact/there-is-no-evidence-for-the-claims-that-israeli-forces-arrested-hezbollah-members-following-the-death-of-a-french-soldier-in-southern-lebanon/ |
| 63 | – | ? | ? | ar | ar | CIA ينفي انطلاق المسيّرات التي استهدفت السودان من الأراضي الإثيوبية | ARIJ | https://arij.net/chatbot-fact/there-is-no-truth-to-the-cias-statements-regarding-the-launch-of-drones-from-ethiopia-that-attacked-khartoum-airport/ |
| 64 | – | ? | ? | ar | ar | كمين لحزب الله يستهدف وحدة عسكرية إسرائيلية | ARIJ | https://arij.net/chatbot-fact/the-video-is-targeting-russian-soldiers-in-ukraine-and-not-israeli-soldiers-in-lebanon/ |
| 65 | – | ? | ? | ar | ar | رئيسة وزراء إيطاليا ترفض مصافحة نتنياهو | ARIJ | https://arij.net/chatbot-fact/the-video-of-meloni-slapping-netanyahu-is-ai-generated/ |
| 66 | – | ? | ? | ar | ar | جنود إسرائيليون أسرهم حزب الله | ARIJ | https://arij.net/chatbot-fact/the-video-of-hezbollah-capturing-two-israeli-soldiers-is-ai-generated/ |
| 67 | – | fa | fa | fa | fa | ژاپن، انیمه‌ای برای کودکان میناب ساخته است. | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-08-iran-claim-japanese-animation-minab-school |
| 68 | – | fa | fa | fa | fa | ادعای بسته‌شدن کامل تنگه باب‌المندب | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-08-iran-misleading-claim-bab-al-mandab-closure |
| 69 | – | fa | ? | fa | fa | ویدیوی منتسب به ورود نیروهای آمریکایی به خاک ایران برای نجات خلبان آمریکایی | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-08-fake-video-american-commandos-in-iran |
| 70 | – | fa | fa | fa | fa | نزدیک ۶۰ میلیون ایرانی حداقل یک بار در این تجمعات خیابانی شرکت کرده‌اند. | فکت‌نامه | https://factnameh.com/fa/fact-checks/2026-06-05-60m-exaggerate-iran-pro-regime-population |
| 71 | in | te | te | te | te | భారత్‌లో గర్భిణి మహిళ వేషంలో ఉన్న కొరియన్ వ్యక్తిని కొందరు యువకులు వేధిస్తున్నప… | FACTLY | https://factly.in/telugu-there-is-no-truth-to-the-claims-circulating-that-young-men-harassed-a-korean-man-who-was-dressed-as-a-pregnant-woman-in-india/ |
| 72 | in | en | en | en | en | The Reserve Bank of India (RBI) has launched new ₹500 plastic currency notes th… | FACTLY | https://factly.in/the-rbi-has-not-launched-any-new-%e2%82%b9500-plastic-currency-notes-without-mahatma-gandhis-photograph-this-viral-image-is-ai-generated/ |
| 73 | – | en | en | en | en | The Simpsons predicted the winner of the 2026 FIFA World Cup decades in advance | FactCrescendo Sri Lanka | https://srilanka.factcrescendo.com/english/the-simpsons-did-not-predict-portugal-winning-the-2026-world-cup/ |
| 74 | in | en | en | en | en | Under the DMK regime, government schools were totally neglected. Students had t… | youturn | https://en.youturn.in/factcheck/fact-check-tvk-nabard-school-infrastructure-scheme-not-new.htmlhttps://en.youturn.in/factcheck/fact-check-tvk-nabard-school-infrastructure-scheme-not-new.html |
| 75 | in | en | ? | fa | en | Thalapathy Loyola Collage Student identity card 1996
#thalapathy #loyolacampus … | youturn | https://en.youturn.in/factcheck/fact-check-cm-vijay-loyola-college-fake-id-card.html |
| 76 | in | en | en | en | en | This is what happens when you Vote-Against-Self-Conscience

Now enjoy Joseph as… | youturn | https://en.youturn.in/factcheck/fact-check-tvk-musthafa-hrce-minister-fake-list.html |
| 77 | in | en | en | en | en | Gen Z protesters demonstrate against PM Modi and the BJP, accusing the governme… | youturn | https://en.youturn.in/factcheck/fact-check-gen-z-protest-modi-effigy-ugc-bill.html |
| 78 | in | en | en | en | en | This news won't be shown by any godi media. The spark of the movement in Bihar … | youturn | https://en.youturn.in/factcheck/fact-check-patna-student-protest-ugc-assam-funeral.html |
| 79 | in | en | en | en | en | Tamil Nadu Chief Minister Vijay T. has announced a complete farm loan waiver sc… | youturn | https://en.youturn.in/factcheck/fact-check-cm-vijay-farm-loan-waiver-misleading.html |
| 80 | in | ta | ta | ta | ta | தஞ்சாவூர் எம்எல்ஏ.. பழைய தமிழ் பெருமையை தூசி தட்டி கிளப்புறாப்ல.. | youturn | https://youturn.in/factcheck/Was-the-moat-of-the-Thanjavur-Big-Temple-cleaned-only-after-the-TVK-government.html |
| 81 | in | ta | ta | ta | ta | தமிழகத்திலேயே முதல்முறையாக.. | youturn | https://youturn.in/factcheck/solid-waste-management-introduced-tn-in-tvk-rule-is-misleading-by-thanthi.html |
| 82 | in | ta | ta | ta | ta | திராவிட மாடல் ஆட்சியில் தோண்டப்பட்ட கல்குவாரி… | youturn | https://youturn.in/factcheck/quarry-in-kerala-falsely-spread-as-one-in-tamilndau-dmk-regime-.html |
| 83 | in | ta | ta | ta | ta | அன்று கரூரில் தொடங்கி திருச்சி வழியாக ஓடிய ஓட்டம் இன்று சென்னையிலும் தொடர்கிறது… | youturn | https://youturn.in/factcheck/Old-video-falsely-shared-as-CM-Vijay-leaving-without-meeting-media.html |
| 84 | in | ta | ta | ta | ta | 10 வயது சிறுமி பாலியல் வன்கொடுமை செய்யப்பட்டு படுகொலை செய்யப்பட்டது தொடர்பான செ… | youturn | https://youturn.in/factcheck/tvk-supporters-misleadingly-claimed-three-police-officers-suspended-laughing-at-press-meet-.html |
| 85 | in | ta | ta | ta | ta | தமிழ்நாடு மாநிலம் முழுவதும் 11.40 லட்சம் விவசாயிகளின் பயிர் கடன்களை முழுமையாக த… | youturn | https://youturn.in/factcheck/puthiyathalaimurai-falsely-spread-tvk-discounted-entire-farm-loans-.html |
| 86 | in | ta | ta | ta | ta | இது நம்ம லிஸ்ட்லியே இல்லையே 

“மக்கள் சர்காரின் ஆட்டம் ஆரம்பம் | youturn | https://youturn.in/factcheck/on-lakh-cash-prize-report-bribery-published-dailythanthi-is-fake.html |
| 87 | in | ta | ta | ta | ta | சீக்கிரம் நல்ல முடிவா எடுங்க boys | youturn | https://youturn.in/factcheck/edited-fake-news-card-cv-shanmugam-spoke-of-suicide-in-party-meeting.html |
| 88 | in | pt | pt | en | en | A Direct Way to Register Public Complaints | youturn | https://youturn.in/factcheck/complaints-submitted-directly-cm-vijay-helpline-number-1100-is-old.html |
| 89 | in | ta | ta | ta | ta | அடுத்த ஆதித்யநாத் யோகியாக மாறினாரா ஜோசப் விஜய் 

தொடர்ந்து இணைப்பில் இருங்கள்..… | yoututn | https://youturn.in/factcheck/chruch-demolished-in-kerala-falsely-claimed-to-be-happened-in-tn-tvk-regime.html |
| 90 | in | ta | ta | ta | ta | பொறுப்பேற்ற முதல் நாளே தரமான சம்பவம் மக்கள் நல் பணி தொடர வாழ்த்துக்கள். | youturn | https://youturn.in/factcheck/old-video-circulating-10-tons-gutkha-destroyed-kanchipuram-tvk-administration.html |
| 91 | in | ta | ta | ta | ta | விவசாயிகள், மட்பாண்ட தொழிலாளர்கள் வண்டல் மண்ணை விலையில்லாமலும் உரிமக்கட்டணம் செ… | youturn | https://youturn.in/factcheck/news-falsely-claimed-website-for-permission-to-take-alluvial-soil-new-plan-tvk-gov.html |
| 92 | in | ta | ta | ta | ta | தவெக ஆட்சி பொறுப்பேற்று கீர்த்தனா தொழிற்துறை அமைச்சராக பதவியேற்றுள்ளார். தற்போத… | youturn | https://youturn.in/factcheck/two-years-old-saint-gobain-investment-mou-falsely-claimed-as-new-one-.html |
| 93 | in | ta | ta | ta | ta | இனிமே சட்டம் தன் கடமையை செய்யும்...

@TVKVijayHQ 

With... TN Police power… | youturn | https://youturn.in/factcheck/jaipur-video-circulates-allegedly-depicting-tn-police-under-tvk-rule.html |
| 94 | in | ta | ta | ta | ta | இதுவரை தமிழகத்தை ஆண்ட எந்த முதல்வரும் காலை பத்து மணிக்கு பணிக்கு வந்து வரும்போத… | youturn | https://youturn.in/factcheck/ai-generated-image-of-cm-vijay-eating-at-secretariat-claimed-to-be-real.html |
| 95 | in | ta | ta | ta | ta | இந்தியா சுதந்திரம் அடைந்ததிலிருந்து, ஒரு தலித் தலைவர் கல்வி அமைச்சராக பதவியேற்ப… | yoututn | https://youturn.in/factcheck/its-falsely-spread-that-rajmohan-is-first-dalit-education-minister-of-tn-.html |
| 96 | in | ta | ta | ta | ta | இதற்கு முன்பு எந்த கட்சி ஆட்சிக்கு வந்தும் வெள்ளை அறிக்கை வெளியிடவில்லை என்றும்… | youturn | https://youturn.in/factcheck/minister-keerthana-spreading-false-no-political-party-tn-released-white-paper.html |
| 97 | in | ta | ta | ta | ta | "40 வருசமா போராடுனே நடக்கல.. CM -க்கு ரொம்ப நன்றி.." Vlog ஆக எடுத்து நன்றி சொன்… | youturn | https://youturn.in/factcheck/tvk-regime-tasmac-shutdown-near-school-tnagar-is-false-news.html |
| 98 | in | ta | ta | ta | ta | இந்த மாற்றத்தைத் தான் எதிர்பார்த்தீர்களா? பெண்களும், குழந்தைகளும்? | youturn | https://youturn.in/factcheck/old-video-circulated-as-drug-addict-youth-attacked-police.html |
| 99 | in | ta | ta | ta | ta | செஞ்சியில் ரூபாய் 1கோடி மதிப்புள்ள 4 டன் குட்கா பொருளை தீவைத்து எரித்த காவல்துற… | youturn | https://youturn.in/factcheck/police-destroyed-4-tons-of-gutkha-during-the-tvk-regime-is-fake.html |
| 100 | in | ta | ta | ta | ta | ’தமிழ்நாட்டில் தடை செய்யப்பட்ட லாட்டரி சீட்டுகள் விற்பனை செய்ததற்காக மூன்று பேர… | youturn | https://youturn.in/factcheck/lottery-3-men-arrested-in-tn-not-a-old-news-but-photo-attached-is-old-one-.html |
| 101 | in | ta | ta | ta | ta | ஒயர்டு இயர்போன்களை விட ப்ளூடூத் ஏர்பாட்கள் 150 மடங்கு அதிக கதிர்வீச்சை வெளியிடு… | youturn | https://youturn.in/factcheck/its-falsely-spread-radiation-from-wireless-airpads-cause-neural-damage-.html |
| 102 | in | ta | ta | ta | ta | இதில் என்ன தவறு.? என்னிடம் கார் இல்லை.. காலில் செருப்பு கூட இல்லாமல் அரசு பேருந… | youturn | https://youturn.in/factcheck/millionaire-tvk-mla-misleading-that-he-doesnt-have-car-travel-by-bus-.html |
| 103 | in | ta | ta | ta | ta | #pmshri school நாங்க இருக்க வரைக்கும் கொண்டு வரவே இல்ல மத்திய அரசு அப்படின்னு த… | youturn | https://youturn.in/factcheck/its-falsely-spread-udumalaipet-kv-school-is-under-pmshri-.html |
| 104 | in | ? | ? | en | en | Next banger

@TVKVijayHQ na - Ella ball um sixer ah parakuthe. 

Super na. Huge… | youturn | https://youturn.in/factcheck/free-coaching-competitive-examinations-only-under-the-tvk-regime-false.html |
