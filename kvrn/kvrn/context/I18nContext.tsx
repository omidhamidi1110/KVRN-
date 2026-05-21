'use client'

import { createContext, useContext, useState, useEffect } from 'react'

export type Locale = 'en' | 'es' | 'fr' | 'ar' | 'zh' | 'hi' | 'pt' | 'de' | 'ja' | 'ko'

export interface LangOption { code: Locale; label: string; nativeLabel: string; rtl?: boolean }

export const LANGUAGES: LangOption[] = [
  { code: 'en', label: 'English',    nativeLabel: 'English' },
  { code: 'es', label: 'Spanish',    nativeLabel: 'Español' },
  { code: 'fr', label: 'French',     nativeLabel: 'Français' },
  { code: 'ar', label: 'Arabic',     nativeLabel: 'العربية', rtl: true },
  { code: 'zh', label: 'Chinese',    nativeLabel: '中文' },
  { code: 'hi', label: 'Hindi',      nativeLabel: 'हिन्दी' },
  { code: 'pt', label: 'Portuguese', nativeLabel: 'Português' },
  { code: 'de', label: 'German',     nativeLabel: 'Deutsch' },
  { code: 'ja', label: 'Japanese',   nativeLabel: '日本語' },
  { code: 'ko', label: 'Korean',     nativeLabel: '한국어' },
]

const EN = {
  // Nav
  shopAll:        'Shop All',
  hoodies:        'Hoodies',
  sweatpants:     'Sweatpants',
  about:          'About',
  trackOrder:     'Track Order',
  waitlist:       'Waitlist',
  contact:        'Contact',
  faq:            'FAQ',
  sizeGuide:      'Size Guide',
  shippingReturns:'Shipping & Returns',
  // Cart / Bag
  bag:            'Bag',
  addToBag:       'Add to Bag',
  addedToBag:     'Added ✓',
  adding:         'Adding…',
  soldOut:        'Sold Out',
  fewLeft:        'Few Left',
  selectSize:     'Select a Size',
  checkout:       'Checkout',
  subtotal:       'Subtotal',
  remove:         'Remove',
  emptyBag:       'Your bag is empty.',
  browse:         'Browse products',
  freeShipping:   'away from complimentary U.S. shipping',
  freeShippingUnlocked: 'Complimentary U.S. shipping unlocked',
  freeShippingNote: 'Complimentary shipping applies to U.S. orders only.',
  shippingCalc:   'Shipping calculated at checkout',
  storeCreditReturns: 'Store credit returns',
  secureCheckout: 'Secure checkout',
  // Shop
  shopNow:        'Shop now',
  viewAll:        'View all',
  theCollection:  'The Collection',
  founderPrice:   'Founder pricing — permanently increases after initial release.',
  // PDP
  size:           'Size',
  color:          'Color',
  completeTheSet: 'Complete the Set',
  theFullSet:     'The Full Set',
  forBoth:        'for both',
  addItem:        'Add',
  sameCollection: 'Same fabric. Same weight. Designed to be worn together.',
  sizeGuideLink:  'Size guide',
  details:        'Details & Construction',
  shipping:       'Shipping',
  returns:        'Returns',
  qualityChecked: 'Quality checked before shipment',
  easySupport:    'Easy support if something arrives wrong',
  theConstruction:'The Construction',
  // Waitlist
  earlyAccess:    'Get early access.',
  dropsOnly:      'Drop notifications only. No spam.',
  collectionOnly: 'Collection access only. Unsubscribe any time.',
  onTheList:      "You're on the list.",
  joinBtn:        'Join',
  emailPlaceholder:'Email address',
  builtFor:       'Built for daily wear.',
  designedFor:    'Designed for permanence.',
  // Contact form
  firstName:      'First name',
  lastName:       'Last name',
  email:          'Email',
  orderNumber:    'Order number',
  orderNumberOpt: 'Order number (optional)',
  subject:        'Subject',
  message:        'Message',
  sendMessage:    'Send message',
  // Track
  trackYourOrder: 'Track your order',
  enterOrder:     'Enter your order number to check status.',
  orderNum:       'Order number',
  search:         'Search',
  notFound:       'Order not found',
  // Footer
  shop:           'Shop',
  support:        'Support',
  legal:          'Legal',
  privacy:        'Privacy',
  terms:          'Terms',
  cookies:        'Cookies',
  allRightsReserved: 'All rights reserved.',
  approxConversion: 'Prices shown in selected currency. Approximate conversion.',
  // FAQ headings
  products:       'Products',
  sizing:         'Sizing',
  // Size guide
  hoodie:         'Hoodie',
  sweatpantsLabel:'Sweatpants',
  shopHoodies:    'Shop Hoodies',
  shopSweatpants: 'Shop Sweatpants',
}

type Strings = typeof EN

const ES: Strings = {
  shopAll:'Ver todo', hoodies:'Sudaderas', sweatpants:'Pantalones', about:'Nosotros',
  trackOrder:'Rastrear pedido', waitlist:'Lista de espera', contact:'Contacto',
  faq:'Preguntas frecuentes', sizeGuide:'Guía de tallas', shippingReturns:'Envíos y devoluciones',
  bag:'Bolsa', addToBag:'Añadir a la bolsa', addedToBag:'Añadido ✓', adding:'Añadiendo…',
  soldOut:'Agotado', fewLeft:'Pocas unidades', selectSize:'Selecciona una talla',
  checkout:'Finalizar compra', subtotal:'Subtotal', remove:'Eliminar',
  emptyBag:'Tu bolsa está vacía.', browse:'Ver productos',
  freeShipping:'para envío gratuito a EE.UU.', freeShippingUnlocked:'Envío gratuito a EE.UU. desbloqueado',
  freeShippingNote:'El envío gratuito aplica solo para pedidos en EE.UU.',
  shippingCalc:'Envío calculado en el pago', storeCreditReturns:'Devoluciones en crédito',
  secureCheckout:'Pago seguro',
  shopNow:'Comprar ahora', viewAll:'Ver todo', theCollection:'La colección',
  founderPrice:'Precio fundador — sube tras el lanzamiento inicial.',
  size:'Talla', color:'Color', completeTheSet:'Completa el conjunto',
  theFullSet:'El conjunto completo', forBoth:'por ambas piezas', addItem:'Añadir',
  sameCollection:'Misma tela. Mismo peso. Diseñadas para llevarse juntas.',
  sizeGuideLink:'Guía de tallas', details:'Detalles y construcción',
  shipping:'Envío', returns:'Devoluciones',
  qualityChecked:'Control de calidad antes del envío',
  easySupport:'Soporte fácil si algo llega mal',
  theConstruction:'La construcción',
  earlyAccess:'Acceso anticipado.', dropsOnly:'Solo notificaciones. Sin spam.',
  collectionOnly:'Solo acceso a colecciones. Cancela cuando quieras.',
  onTheList:'Ya estás en la lista.',
  joinBtn:'Unirse', emailPlaceholder:'Correo electrónico',
  builtFor:'Hecha para el día a día.', designedFor:'Diseñada para durar.',
  firstName:'Nombre', lastName:'Apellido', email:'Correo electrónico',
  orderNumber:'Número de pedido', orderNumberOpt:'Número de pedido (opcional)',
  subject:'Asunto', message:'Mensaje', sendMessage:'Enviar',
  trackYourOrder:'Rastrear pedido', enterOrder:'Introduce tu número de pedido.',
  orderNum:'Número de pedido', search:'Buscar', notFound:'Pedido no encontrado',
  shop:'Tienda', support:'Soporte', legal:'Legal', privacy:'Privacidad',
  terms:'Términos', cookies:'Cookies', allRightsReserved:'Todos los derechos reservados.',
  approxConversion:'Precios en moneda seleccionada. Conversión aproximada.',
  products:'Productos', sizing:'Tallas',
  hoodie:'Sudadera con capucha', sweatpantsLabel:'Pantalón deportivo',
  shopHoodies:'Comprar sudaderas', shopSweatpants:'Comprar pantalones',
}

const FR: Strings = {
  shopAll:'Tout voir', hoodies:'Sweats à capuche', sweatpants:'Joggings', about:'À propos',
  trackOrder:'Suivre ma commande', waitlist:"Liste d'attente", contact:'Contact',
  faq:'Questions fréquentes', sizeGuide:'Guide des tailles', shippingReturns:'Livraison et retours',
  bag:'Panier', addToBag:'Ajouter au panier', addedToBag:'Ajouté ✓', adding:'Ajout…',
  soldOut:'Épuisé', fewLeft:'Peu de stock', selectSize:'Choisir une taille',
  checkout:'Finaliser', subtotal:'Sous-total', remove:'Supprimer',
  emptyBag:'Votre panier est vide.', browse:'Voir les produits',
  freeShipping:'pour la livraison gratuite USA', freeShippingUnlocked:'Livraison gratuite USA débloquée',
  freeShippingNote:'Livraison gratuite pour les commandes aux États-Unis uniquement.',
  shippingCalc:'Livraison calculée à la commande', storeCreditReturns:'Retours en avoir',
  secureCheckout:'Paiement sécurisé',
  shopNow:'Acheter', viewAll:'Voir tout', theCollection:'La collection',
  founderPrice:'Prix fondateur — augmente après le lancement.',
  size:'Taille', color:'Couleur', completeTheSet:"Compléter l'ensemble",
  theFullSet:"L'ensemble complet", forBoth:'pour les deux', addItem:'Ajouter',
  sameCollection:'Même tissu. Même poids. Conçus pour être portés ensemble.',
  sizeGuideLink:'Guide des tailles', details:'Détails et construction',
  shipping:'Livraison', returns:'Retours',
  qualityChecked:'Contrôle qualité avant expédition',
  easySupport:'Assistance facile en cas de problème',
  theConstruction:'La construction',
  earlyAccess:'Accès anticipé.', dropsOnly:'Notifications uniquement. Sans spam.',
  collectionOnly:"Accès aux collections uniquement. Désinscription à tout moment.",
  onTheList:'Vous êtes sur la liste.',
  joinBtn:'Rejoindre', emailPlaceholder:'Adresse e-mail',
  builtFor:'Fait pour le quotidien.', designedFor:'Conçu pour durer.',
  firstName:'Prénom', lastName:'Nom', email:'E-mail',
  orderNumber:'Numéro de commande', orderNumberOpt:'Numéro de commande (optionnel)',
  subject:'Sujet', message:'Message', sendMessage:'Envoyer',
  trackYourOrder:'Suivre ma commande', enterOrder:'Entrez votre numéro de commande.',
  orderNum:'Numéro de commande', search:'Rechercher', notFound:'Commande introuvable',
  shop:'Boutique', support:'Assistance', legal:'Mentions légales', privacy:'Confidentialité',
  terms:'Conditions', cookies:'Cookies', allRightsReserved:'Tous droits réservés.',
  approxConversion:'Prix affichés dans la devise sélectionnée. Conversion approximative.',
  products:'Produits', sizing:'Tailles',
  hoodie:'Sweat à capuche', sweatpantsLabel:'Jogging',
  shopHoodies:'Acheter les sweats', shopSweatpants:'Acheter les joggings',
}

const AR: Strings = {
  shopAll:'تسوق الكل', hoodies:'هوديات', sweatpants:'بناطيل رياضية', about:'من نحن',
  trackOrder:'تتبع الطلب', waitlist:'قائمة الانتظار', contact:'تواصل معنا',
  faq:'أسئلة شائعة', sizeGuide:'دليل المقاسات', shippingReturns:'الشحن والإرجاع',
  bag:'الحقيبة', addToBag:'أضف إلى الحقيبة', addedToBag:'تمت الإضافة ✓', adding:'جارٍ الإضافة…',
  soldOut:'نفد المخزون', fewLeft:'كميات محدودة', selectSize:'اختر المقاس',
  checkout:'إتمام الشراء', subtotal:'المجموع الجزئي', remove:'إزالة',
  emptyBag:'حقيبتك فارغة.', browse:'تصفح المنتجات',
  freeShipping:'للحصول على شحن مجاني للولايات المتحدة', freeShippingUnlocked:'تم إلغاء قفل الشحن المجاني للولايات المتحدة',
  freeShippingNote:'الشحن المجاني يسري على الطلبات داخل الولايات المتحدة فقط.',
  shippingCalc:'يُحسب الشحن عند الدفع', storeCreditReturns:'مرتجعات بالرصيد',
  secureCheckout:'دفع آمن',
  shopNow:'تسوق الآن', viewAll:'عرض الكل', theCollection:'المجموعة',
  founderPrice:'سعر المؤسسين — يرتفع بعد الإطلاق.',
  size:'المقاس', color:'اللون', completeTheSet:'أكمل الطقم',
  theFullSet:'الطقم الكامل', forBoth:'للقطعتين', addItem:'إضافة',
  sameCollection:'نفس القماش. نفس الوزن. مصممة للارتداء معاً.',
  sizeGuideLink:'دليل المقاسات', details:'التفاصيل والتصنيع',
  shipping:'الشحن', returns:'المرتجعات',
  qualityChecked:'فحص الجودة قبل الشحن',
  easySupport:'دعم سهل في حال وصول المنتج بشكل خاطئ',
  theConstruction:'التصنيع',
  earlyAccess:'احصل على وصول مبكر.', dropsOnly:'إشعارات الإطلاق فقط. لا بريد عشوائي.',
  collectionOnly:'وصول إلى المجموعات فقط. إلغاء الاشتراك في أي وقت.',
  onTheList:'أنت في القائمة.',
  joinBtn:'انضم', emailPlaceholder:'البريد الإلكتروني',
  builtFor:'مصنوع للارتداء اليومي.', designedFor:'مصمم للديمومة.',
  firstName:'الاسم الأول', lastName:'اسم العائلة', email:'البريد الإلكتروني',
  orderNumber:'رقم الطلب', orderNumberOpt:'رقم الطلب (اختياري)',
  subject:'الموضوع', message:'الرسالة', sendMessage:'إرسال',
  trackYourOrder:'تتبع طلبك', enterOrder:'أدخل رقم طلبك للتحقق من الحالة.',
  orderNum:'رقم الطلب', search:'بحث', notFound:'الطلب غير موجود',
  shop:'التسوق', support:'الدعم', legal:'قانوني', privacy:'الخصوصية',
  terms:'الشروط', cookies:'ملفات تعريف الارتباط', allRightsReserved:'جميع الحقوق محفوظة.',
  approxConversion:'الأسعار بالعملة المختارة. التحويل تقريبي.',
  products:'المنتجات', sizing:'المقاسات',
  hoodie:'هودي', sweatpantsLabel:'بنطلون رياضي',
  shopHoodies:'تسوق الهوديات', shopSweatpants:'تسوق البناطيل',
}

const ZH: Strings = {
  shopAll:'全部商品', hoodies:'连帽卫衣', sweatpants:'运动裤', about:'关于我们',
  trackOrder:'追踪订单', waitlist:'等候名单', contact:'联系我们',
  faq:'常见问题', sizeGuide:'尺码指南', shippingReturns:'配送与退货',
  bag:'购物袋', addToBag:'加入购物袋', addedToBag:'已添加 ✓', adding:'添加中…',
  soldOut:'售罄', fewLeft:'库存不多', selectSize:'选择尺码',
  checkout:'结账', subtotal:'小计', remove:'删除',
  emptyBag:'您的购物袋是空的。', browse:'浏览商品',
  freeShipping:'即可享受美国免费配送', freeShippingUnlocked:'美国免费配送已解锁',
  freeShippingNote:'免费配送仅适用于美国订单。',
  shippingCalc:'结账时计算运费', storeCreditReturns:'商店积分退货',
  secureCheckout:'安全结账',
  shopNow:'立即购物', viewAll:'查看全部', theCollection:'系列',
  founderPrice:'创始人价格 — 首发后将永久上调。',
  size:'尺码', color:'颜色', completeTheSet:'搭配全套',
  theFullSet:'完整套装', forBoth:'两件合计', addItem:'添加',
  sameCollection:'同款面料。同等重量。设计为整套穿搭。',
  sizeGuideLink:'尺码指南', details:'详情与工艺',
  shipping:'配送', returns:'退货',
  qualityChecked:'发货前质量检验',
  easySupport:'如有问题轻松获得支持',
  theConstruction:'工艺',
  earlyAccess:'获得优先访问权。', dropsOnly:'仅限新品通知。无垃圾邮件。',
  collectionOnly:'仅限系列访问权限。随时取消订阅。',
  onTheList:'您已加入名单。',
  joinBtn:'加入', emailPlaceholder:'电子邮件地址',
  builtFor:'为日常穿着而生。', designedFor:'为持久耐用而设计。',
  firstName:'名字', lastName:'姓氏', email:'电子邮件',
  orderNumber:'订单号', orderNumberOpt:'订单号（可选）',
  subject:'主题', message:'留言', sendMessage:'发送',
  trackYourOrder:'追踪您的订单', enterOrder:'输入您的订单号以查询状态。',
  orderNum:'订单号', search:'搜索', notFound:'未找到订单',
  shop:'购物', support:'支持', legal:'法律', privacy:'隐私',
  terms:'条款', cookies:'Cookie', allRightsReserved:'版权所有。',
  approxConversion:'价格以所选货币显示。为近似换算。',
  products:'产品', sizing:'尺码',
  hoodie:'连帽卫衣', sweatpantsLabel:'运动裤',
  shopHoodies:'购买连帽卫衣', shopSweatpants:'购买运动裤',
}

// Remaining locales — use EN with key terms translated
function makeFallback(overrides: Partial<Strings>): Strings {
  return { ...EN, ...overrides }
}

const HI = makeFallback({
  shopAll:'सभी देखें', hoodies:'हुडी', sweatpants:'स्वेटपैंट', about:'हमारे बारे में',
  trackOrder:'ऑर्डर ट्रैक करें', bag:'बैग', addToBag:'बैग में जोड़ें',
  addedToBag:'जोड़ा गया ✓', soldOut:'बिक गया', fewLeft:'कम बचा',
  selectSize:'साइज़ चुनें', checkout:'चेकआउट', shopNow:'अभी खरीदें',
  joinBtn:'जुड़ें', emailPlaceholder:'ईमेल पता',
  builtFor:'रोज़ पहनने के लिए बना।', designedFor:'टिकाऊपन के लिए डिज़ाइन किया।',
  sendMessage:'भेजें', search:'खोजें',
})

const PT = makeFallback({
  shopAll:'Ver tudo', hoodies:'Moletons', sweatpants:'Calças de moletom', about:'Sobre',
  trackOrder:'Rastrear pedido', bag:'Sacola', addToBag:'Adicionar à sacola',
  addedToBag:'Adicionado ✓', soldOut:'Esgotado', fewLeft:'Poucas unidades',
  selectSize:'Selecione o tamanho', checkout:'Finalizar compra',
  shopNow:'Comprar agora', joinBtn:'Entrar', emailPlaceholder:'Endereço de e-mail',
  builtFor:'Feito para o uso diário.', designedFor:'Projetado para durar.',
  sendMessage:'Enviar mensagem', search:'Buscar',
})

const DE = makeFallback({
  shopAll:'Alle ansehen', hoodies:'Hoodies', sweatpants:'Jogginghosen', about:'Über uns',
  trackOrder:'Bestellung verfolgen', bag:'Tasche', addToBag:'In die Tasche',
  addedToBag:'Hinzugefügt ✓', soldOut:'Ausverkauft', fewLeft:'Nur noch wenige',
  selectSize:'Größe wählen', checkout:'Zur Kasse',
  shopNow:'Jetzt kaufen', joinBtn:'Beitreten', emailPlaceholder:'E-Mail-Adresse',
  builtFor:'Für den täglichen Gebrauch.', designedFor:'Für Langlebigkeit entworfen.',
  sendMessage:'Nachricht senden', search:'Suchen',
})

const JA = makeFallback({
  shopAll:'すべて見る', hoodies:'パーカー', sweatpants:'スウェットパンツ', about:'ブランドについて',
  trackOrder:'注文を追跡', bag:'バッグ', addToBag:'バッグに追加',
  addedToBag:'追加済み ✓', soldOut:'売り切れ', fewLeft:'残りわずか',
  selectSize:'サイズを選択', checkout:'チェックアウト',
  shopNow:'今すぐ購入', joinBtn:'登録', emailPlaceholder:'メールアドレス',
  builtFor:'毎日の着用のために。', designedFor:'永続性のためのデザイン。',
  sendMessage:'送信', search:'検索',
})

const KO = makeFallback({
  shopAll:'전체 보기', hoodies:'후디', sweatpants:'스웨트팬츠', about:'브랜드 소개',
  trackOrder:'주문 추적', bag:'가방', addToBag:'가방에 담기',
  addedToBag:'담김 ✓', soldOut:'품절', fewLeft:'수량 부족',
  selectSize:'사이즈 선택', checkout:'결제',
  shopNow:'지금 쇼핑', joinBtn:'가입', emailPlaceholder:'이메일 주소',
  builtFor:'일상 착용을 위해 만들었습니다.', designedFor:'지속성을 위해 디자인되었습니다.',
  sendMessage:'보내기', search:'검색',
})

const TRANSLATIONS: Record<Locale, Strings> = {
  en: EN, es: ES, fr: FR, ar: AR, zh: ZH,
  hi: HI, pt: PT, de: DE, ja: JA, ko: KO,
}

interface I18nCtx {
  locale:    Locale
  setLocale: (l: Locale) => void
  t:         Strings
  isRTL:     boolean
}

const I18nContext = createContext<I18nCtx>({
  locale: 'en', setLocale: () => {}, t: EN, isRTL: false,
})

const STORAGE_KEY = 'kvrn_locale'

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en')

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) ?? 'en') as Locale
    if (LANGUAGES.some(l => l.code === stored)) setLocaleState(stored)
  }, [])

  const setLocale = (l: Locale) => {
    setLocaleState(l)
    localStorage.setItem(STORAGE_KEY, l)
    const lang = LANGUAGES.find(x => x.code === l)
    document.documentElement.dir  = lang?.rtl ? 'rtl' : 'ltr'
    document.documentElement.lang = l
  }

  const lang  = LANGUAGES.find(l => l.code === locale)
  const isRTL = lang?.rtl ?? false

  return (
    <I18nContext.Provider value={{ locale, setLocale, t: TRANSLATIONS[locale], isRTL }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() { return useContext(I18nContext) }
