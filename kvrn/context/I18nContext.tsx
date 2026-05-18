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

// Core UI strings — professionally translated
type Strings = typeof EN

const EN = {
  shopAll:       'Shop All',
  hoodies:       'Hoodies',
  sweatpants:    'Sweatpants',
  about:         'About',
  trackOrder:    'Track Order',
  waitlist:      'Waitlist',
  contact:       'Contact',
  faq:           'FAQ',
  sizeGuide:     'Size Guide',
  addToBag:      'Add to Bag',
  soldOut:       'Sold Out',
  fewLeft:       'Few Left',
  selectSize:    'Select a Size',
  bag:           'Bag',
  saved:         'Saved',
  shopNow:       'Shop Now',
  viewAll:       'View All',
  theCollection: 'The Collection',
  joinWaitlist:  'Join the waitlist',
  sendMessage:   'Send message',
  firstName:     'First name',
  lastName:      'Last name',
  email:         'Email',
  message:       'Message',
  subject:       'Subject',
  orderNumber:   'Order number',
  secureCheckout:'Secure checkout',
  returns:       'Returns',
  shipping:      'Shipping',
  founderPrice:  'Founder pricing — increases after initial release.',
}

const TRANSLATIONS: Record<Locale, Strings> = {
  en: EN,
  es: {
    shopAll: 'Ver todo', hoodies: 'Sudaderas', sweatpants: 'Pantalones', about: 'Nosotros',
    trackOrder: 'Rastrear pedido', waitlist: 'Lista de espera', contact: 'Contacto',
    faq: 'Preguntas frecuentes', sizeGuide: 'Guía de tallas', addToBag: 'Añadir a la bolsa',
    soldOut: 'Agotado', fewLeft: 'Pocas unidades', selectSize: 'Selecciona una talla',
    bag: 'Bolsa', saved: 'Guardado', shopNow: 'Comprar ahora', viewAll: 'Ver todo',
    theCollection: 'La colección', joinWaitlist: 'Unirse a la lista', sendMessage: 'Enviar mensaje',
    firstName: 'Nombre', lastName: 'Apellido', email: 'Correo', message: 'Mensaje',
    subject: 'Asunto', orderNumber: 'Número de pedido', secureCheckout: 'Pago seguro',
    returns: 'Devoluciones', shipping: 'Envío',
    founderPrice: 'Precio fundador — sube después del lanzamiento inicial.',
  },
  fr: {
    shopAll: 'Tout voir', hoodies: 'Sweats à capuche', sweatpants: 'Joggings', about: 'À propos',
    trackOrder: 'Suivre ma commande', waitlist: 'Liste d\'attente', contact: 'Contact',
    faq: 'Questions fréquentes', sizeGuide: 'Guide des tailles', addToBag: 'Ajouter au panier',
    soldOut: 'Épuisé', fewLeft: 'Peu de stock', selectSize: 'Choisir une taille',
    bag: 'Panier', saved: 'Enregistré', shopNow: 'Acheter maintenant', viewAll: 'Voir tout',
    theCollection: 'La collection', joinWaitlist: 'Rejoindre la liste', sendMessage: 'Envoyer',
    firstName: 'Prénom', lastName: 'Nom', email: 'E-mail', message: 'Message',
    subject: 'Sujet', orderNumber: 'Numéro de commande', secureCheckout: 'Paiement sécurisé',
    returns: 'Retours', shipping: 'Livraison',
    founderPrice: 'Prix fondateur — augmente après le lancement.',
  },
  ar: {
    shopAll: 'تسوق الكل', hoodies: 'هوديات', sweatpants: 'بناطيل رياضية', about: 'من نحن',
    trackOrder: 'تتبع الطلب', waitlist: 'قائمة الانتظار', contact: 'تواصل معنا',
    faq: 'أسئلة شائعة', sizeGuide: 'دليل المقاسات', addToBag: 'أضف إلى الحقيبة',
    soldOut: 'نفد المخزون', fewLeft: 'كميات محدودة', selectSize: 'اختر المقاس',
    bag: 'الحقيبة', saved: 'المحفوظات', shopNow: 'تسوق الآن', viewAll: 'عرض الكل',
    theCollection: 'المجموعة', joinWaitlist: 'انضم للقائمة', sendMessage: 'إرسال',
    firstName: 'الاسم الأول', lastName: 'اسم العائلة', email: 'البريد الإلكتروني', message: 'الرسالة',
    subject: 'الموضوع', orderNumber: 'رقم الطلب', secureCheckout: 'دفع آمن',
    returns: 'المرتجعات', shipping: 'الشحن',
    founderPrice: 'سعر المؤسسين — يرتفع بعد الإطلاق.',
  },
  zh: {
    shopAll: '全部商品', hoodies: '连帽卫衣', sweatpants: '运动裤', about: '关于我们',
    trackOrder: '追踪订单', waitlist: '等候名单', contact: '联系我们',
    faq: '常见问题', sizeGuide: '尺码指南', addToBag: '加入购物袋',
    soldOut: '售罄', fewLeft: '库存不多', selectSize: '选择尺码',
    bag: '购物袋', saved: '已保存', shopNow: '立即购物', viewAll: '查看全部',
    theCollection: '系列', joinWaitlist: '加入等候名单', sendMessage: '发送',
    firstName: '名字', lastName: '姓氏', email: '电子邮件', message: '留言',
    subject: '主题', orderNumber: '订单号', secureCheckout: '安全结账',
    returns: '退货', shipping: '配送',
    founderPrice: '创始人价格 — 首批发售后将上调。',
  },
  hi: {
    shopAll: 'सभी देखें', hoodies: 'हुडी', sweatpants: 'स्वेटपैंट', about: 'हमारे बारे में',
    trackOrder: 'ऑर्डर ट्रैक करें', waitlist: 'वेटलिस्ट', contact: 'संपर्क करें',
    faq: 'अक्सर पूछे जाने वाले प्रश्न', sizeGuide: 'साइज़ गाइड', addToBag: 'बैग में जोड़ें',
    soldOut: 'बिक गया', fewLeft: 'कम बचा', selectSize: 'साइज़ चुनें',
    bag: 'बैग', saved: 'सेव किया', shopNow: 'अभी खरीदें', viewAll: 'सभी देखें',
    theCollection: 'संग्रह', joinWaitlist: 'वेटलिस्ट में शामिल हों', sendMessage: 'भेजें',
    firstName: 'पहला नाम', lastName: 'उपनाम', email: 'ईमेल', message: 'संदेश',
    subject: 'विषय', orderNumber: 'ऑर्डर नंबर', secureCheckout: 'सुरक्षित चेकआउट',
    returns: 'वापसी', shipping: 'शिपिंग',
    founderPrice: 'संस्थापक मूल्य — पहली रिलीज़ के बाद बढ़ेगा।',
  },
  pt: {
    shopAll: 'Ver tudo', hoodies: 'Moletons', sweatpants: 'Calças de moletom', about: 'Sobre',
    trackOrder: 'Rastrear pedido', waitlist: 'Lista de espera', contact: 'Contato',
    faq: 'Perguntas frequentes', sizeGuide: 'Guia de tamanhos', addToBag: 'Adicionar à sacola',
    soldOut: 'Esgotado', fewLeft: 'Poucas unidades', selectSize: 'Selecione o tamanho',
    bag: 'Sacola', saved: 'Salvos', shopNow: 'Comprar agora', viewAll: 'Ver tudo',
    theCollection: 'A coleção', joinWaitlist: 'Entrar na lista', sendMessage: 'Enviar mensagem',
    firstName: 'Nome', lastName: 'Sobrenome', email: 'E-mail', message: 'Mensagem',
    subject: 'Assunto', orderNumber: 'Número do pedido', secureCheckout: 'Pagamento seguro',
    returns: 'Devoluções', shipping: 'Entrega',
    founderPrice: 'Preço fundador — aumenta após o lançamento.',
  },
  de: {
    shopAll: 'Alle ansehen', hoodies: 'Hoodies', sweatpants: 'Jogginghosen', about: 'Über uns',
    trackOrder: 'Bestellung verfolgen', waitlist: 'Warteliste', contact: 'Kontakt',
    faq: 'Häufige Fragen', sizeGuide: 'Größentabelle', addToBag: 'In die Tasche',
    soldOut: 'Ausverkauft', fewLeft: 'Nur noch wenige', selectSize: 'Größe wählen',
    bag: 'Tasche', saved: 'Gespeichert', shopNow: 'Jetzt kaufen', viewAll: 'Alle ansehen',
    theCollection: 'Die Kollektion', joinWaitlist: 'Warteliste beitreten', sendMessage: 'Senden',
    firstName: 'Vorname', lastName: 'Nachname', email: 'E-Mail', message: 'Nachricht',
    subject: 'Betreff', orderNumber: 'Bestellnummer', secureCheckout: 'Sicher bezahlen',
    returns: 'Rücksendungen', shipping: 'Versand',
    founderPrice: 'Gründerpreis — steigt nach dem Erstverkauf.',
  },
  ja: {
    shopAll: 'すべて見る', hoodies: 'パーカー', sweatpants: 'スウェットパンツ', about: 'ブランドについて',
    trackOrder: '注文を追跡', waitlist: 'ウェイトリスト', contact: 'お問い合わせ',
    faq: 'よくある質問', sizeGuide: 'サイズガイド', addToBag: 'バッグに追加',
    soldOut: '売り切れ', fewLeft: '残りわずか', selectSize: 'サイズを選択',
    bag: 'バッグ', saved: '保存済み', shopNow: '今すぐ購入', viewAll: 'すべて見る',
    theCollection: 'コレクション', joinWaitlist: 'ウェイトリストに登録', sendMessage: '送信',
    firstName: '名', lastName: '姓', email: 'メールアドレス', message: 'メッセージ',
    subject: '件名', orderNumber: '注文番号', secureCheckout: '安全なチェックアウト',
    returns: '返品', shipping: '配送',
    founderPrice: 'ファウンダー価格 — 初回販売後に価格が上がります。',
  },
  ko: {
    shopAll: '전체 보기', hoodies: '후디', sweatpants: '스웨트팬츠', about: '브랜드 소개',
    trackOrder: '주문 추적', waitlist: '대기 목록', contact: '문의',
    faq: '자주 묻는 질문', sizeGuide: '사이즈 가이드', addToBag: '가방에 담기',
    soldOut: '품절', fewLeft: '수량 부족', selectSize: '사이즈 선택',
    bag: '가방', saved: '저장됨', shopNow: '지금 쇼핑', viewAll: '전체 보기',
    theCollection: '컬렉션', joinWaitlist: '대기 목록 참가', sendMessage: '보내기',
    firstName: '이름', lastName: '성', email: '이메일', message: '메시지',
    subject: '제목', orderNumber: '주문 번호', secureCheckout: '안전한 결제',
    returns: '반품', shipping: '배송',
    founderPrice: '파운더 가격 — 초기 출시 후 인상됩니다.',
  },
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
    // Apply RTL direction to document
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
