import Link from 'next/link'
import type {ReactNode} from 'react'

const TERMS = String.raw`These Messaging Terms & Conditions (“Messaging Terms”) apply to the KVRN recurring text-messaging program (the “Program”).

By affirmatively opting in to the Program, you agree to these Messaging Terms and the KVRN Messaging Privacy Policy.

1. PROGRAM NAME AND DESCRIPTION
Program name: KVRN Messaging Program
The Program provides recurring messages from KVRN relating to topics such as:
• Product launches and drops
• Restocks
• Early access
• Promotional offers
• Discount information
• Brand or product updates reasonably related to the Program
Messages may be delivered through SMS or MMS and, if KVRN later enables and supports it, other compatible mobile-messaging formats such as RCS.
KVRN currently uses Twilio as a messaging service provider.
The Program is for KVRN's own products, launches, restocks, promotions, and related KVRN communications. KVRN does not use your consent to this Program as consent for unrelated third-party or affiliate marketing.

2. CONSENT
By opting in, you authorize KVRN to send recurring automated marketing messages to the mobile telephone number you provide.
Consent may be collected through approved methods such as:
• A KVRN website signup form with affirmative SMS consent
• A KVRN keyword signup flow
• Another KVRN-controlled signup method that clearly discloses the Program terms
Consent to receive marketing messages is not a condition of purchasing any KVRN product or service.
You represent that:
• You are the subscriber or an authorized user of the mobile number you provide
• The information you provide is accurate
• You are at least 18 years old
• You are permitted to participate in the Program under applicable law

3. RECURRING MESSAGES AND FREQUENCY
The Program sends recurring messages.
Message frequency varies based on launches, restocks, promotions, and other Program activity.
KVRN does not promise a fixed number of messages per day, week, or month.

4. MESSAGE AND DATA RATES
Message and data rates may apply.
Your wireless carrier’s rates, data plan, roaming rules, and other charges are your responsibility.

5. OPTING OUT
Reply STOP to a KVRN marketing message to unsubscribe.
KVRN and its messaging provider may also recognize other standard or legally valid opt-out commands, including commands such as END, CANCEL, UNSUBSCRIBE, QUIT, REVOKE, or OPT OUT where supported.
You may also revoke consent using another reasonable method recognized by applicable law, including contacting support@kvrn.shop and clearly requesting removal from the KVRN marketing SMS program.
After an opt-out request, you may receive one final confirmation message stating that you have been unsubscribed.
KVRN may retain a suppression record so that the opt-out continues to be honored.

6. REJOINING THE PROGRAM
If you previously opted out, you may rejoin only by providing new valid consent.
Depending on the messaging configuration, recognized opt-in commands may include START or UNSTOP.
A new website signup or another affirmative KVRN-controlled opt-in method may also be used.

7. HELP
Reply HELP for help.
You may also contact:
support@kvrn.shop
KVRN may provide additional support instructions in the automated HELP response.

8. NUMBER REASSIGNMENT AND AUTHORIZED USE
You must provide a mobile number that you are authorized to use.
If you stop using the number, transfer it, or believe it has been reassigned, please opt out or contact KVRN so that marketing messages are not intentionally sent to a new user of that number.
KVRN may use provider tools or other reasonable safeguards intended to reduce messaging to reassigned numbers.

9. QUIET HOURS AND DELIVERY TIMING
KVRN intends to send non-essential marketing messages only at times permitted by applicable law, carrier rules, and messaging-provider requirements.
Carrier or network delays can cause a message to arrive later than the time KVRN initiated it.
Nothing in these Messaging Terms is intended to waive or override a legally applicable time-of-day restriction.

10. DELIVERY AND CARRIER DISCLAIMER
Delivery is subject to your wireless carrier, network availability, device compatibility, and other factors outside KVRN’s control.
Carriers are not liable for any delayed or undelivered messages.
KVRN does not guarantee that every message will be delivered or delivered at a particular time.

11. SUPPORTED CARRIERS AND DEVICES
The Program may not be available on every carrier, device, country, or messaging technology.
Features may vary depending on the recipient’s device, carrier, messaging application, and location.

12. CHANGES TO SENDING NUMBER OR PROVIDER
KVRN may change the telephone number, sender, messaging service, or service provider used to operate the Program.
If KVRN changes the sender, you remain responsible for following the opt-out instructions included in KVRN messages.
A change in service provider does not transfer your consent to unrelated third parties. Your consent is for KVRN’s Program.

13. PRIVACY
KVRN’s handling of mobile information is described in:
• KVRN Privacy Policy
• KVRN Messaging Privacy Policy
KVRN does not sell or share SMS opt-in data, mobile telephone numbers, or SMS consent information with third parties or affiliates for their own marketing or promotional purposes.

14. PROGRAM SECURITY AND ABUSE
KVRN may take reasonable steps to prevent:
• Fraudulent enrollment
• Unauthorized use of another person’s number
• Abuse of signup incentives
• Bot or automated signup activity
• Attempts to manipulate opt-in or discount systems
KVRN may suspend or refuse Program participation where reasonably necessary to prevent fraud, abuse, or unlawful activity.

15. MARKETING VS. TRANSACTIONAL COMMUNICATIONS
These Messaging Terms govern the recurring KVRN marketing Program.
If KVRN later offers a separate transactional SMS service for specific order, security, or support messages, KVRN will apply the consent and disclosure rules that are appropriate to that use case.
Opting out of the marketing Program does not authorize KVRN to continue sending marketing messages under another label.

16. CHANGES TO THE PROGRAM OR THESE TERMS
KVRN may update the Program or these Messaging Terms.
If a change requires new consent under applicable law, KVRN will obtain that consent before relying on the change.
For other updates, KVRN may post revised terms and update the “Last updated” date.

17. TERMINATION
KVRN may suspend or discontinue the Program at any time.
You may leave the Program at any time using the opt-out methods described above.
Sections that reasonably need to survive termination, including privacy, records, disclaimers, and dispute-related provisions, may continue to apply.

18. GOVERNING LAW
These Messaging Terms are governed by applicable federal law and the laws of the State of California, except where mandatory law in another jurisdiction applies.
Nothing in these Messaging Terms limits a right or remedy that cannot legally be waived.
These Messaging Terms do not create a binding-arbitration requirement.

19. CONTACT
For Program support:
support@kvrn.shop
For the fastest automated opt-out, reply STOP to a KVRN marketing message.`
const PRIVACY = String.raw`This Messaging Privacy Policy explains how KVRN collects, uses, and discloses personal information in connection with the KVRN text-messaging program.
This policy supplements the main KVRN Privacy Policy.

1. INFORMATION WE COLLECT FOR THE MESSAGING PROGRAM
When you join, use, or leave the KVRN messaging program, KVRN may collect:
• Mobile telephone number
• Date and time of consent
• Consent source or signup method
• Consent status
• Keyword or signup-flow information
• Messages you send to KVRN
• Message-delivery status
• Message identifiers
• Opt-in, opt-out, and HELP events
• Date and time of opt-out or re-opt-in
• Error or delivery codes
• Promotion or discount information associated with the signup flow
• Technical metadata needed to operate and secure the Program
KVRN may also associate your mobile number with other KVRN information when reasonably necessary to operate the Program, honor preferences, prevent fraud, or support a transaction.

2. HOW WE USE MESSAGING INFORMATION
KVRN may use messaging information to:
• Send recurring marketing messages after valid consent
• Confirm enrollment
• Deliver Program promotions or updates
• Process STOP, START, HELP, and other supported consent events
• Maintain an internal do-not-contact/suppression record
• Prevent fraudulent or unauthorized signup
• Prevent abuse of signup incentives
• Troubleshoot delivery
• Monitor messaging reliability
• Maintain records demonstrating consent or revocation
• Comply with applicable law, carrier rules, and provider requirements
• Respond to customer support requests

3. TWILIO
KVRN currently uses Twilio to provide messaging infrastructure.
Twilio may process:
• Your mobile number
• Message content
• Message-delivery status
• Message identifiers
• Opt-in/opt-out/help events
• Technical information needed to route, deliver, block, or support messages
Twilio acts as a service provider supporting KVRN’s Program and may apply its own security, anti-fraud, carrier, opt-out, and compliance systems.
KVRN may synchronize consent or opt-out status with Twilio so that a subscriber who has opted out is blocked from receiving further marketing messages.

4. NO SALE OR THIRD-PARTY MARKETING USE OF SMS CONSENT
KVRN does not sell or share SMS opt-in data, mobile telephone numbers, or SMS consent information with third parties or affiliates for their own marketing or promotional purposes.
Mobile information may be disclosed to service providers only as reasonably necessary to operate, secure, support, and deliver the KVRN messaging program, or as otherwise required by law.
No unrelated third party may rely on your consent to the KVRN Program as consent to market its own products or services to you.

5. OPT-OUT AND SUPPRESSION RECORDS
If you opt out, KVRN may retain:
• Your mobile number
• Opt-out status
• Date of opt-out
• Consent history
• Limited messaging metadata
KVRN retains these records so that it can continue honoring your request not to receive marketing messages and document the consent history.
Deleting all evidence of an opt-out could cause a number to be marketed to again, so suppression records may be retained even after other marketing information is deleted.

6. REASSIGNED NUMBERS
If a mobile number is reassigned to a new subscriber, the new subscriber may not have provided the original consent.
KVRN may use Twilio or other provider-supported reassigned-number safeguards to help identify reassigned numbers and reduce messages sent without current consent.
If you stop using a number, you should opt out before relinquishing it when possible.

7. MESSAGE CONTENT
Messages you send to KVRN may be processed and stored as needed to:
• Process keywords
• Provide HELP or support
• Investigate abuse
• Resolve a complaint
• Maintain legally necessary records
Do not send payment-card numbers, passwords, government identification, tax identification numbers, bank credentials, medical information, or other highly sensitive information by SMS.

8. SECURITY
KVRN uses reasonable administrative and technical safeguards intended to protect messaging information.
No messaging, storage, or transmission system can be guaranteed completely secure.

9. RETENTION
KVRN retains messaging information for as long as reasonably necessary to:
• Operate the Program
• Honor consent and opt-out preferences
• Maintain suppression records
• Investigate delivery or abuse
• Comply with applicable law
• Resolve disputes
• Maintain appropriate business and compliance records
Different categories of messaging information may be kept for different periods.

10. CHILDREN AND AGE
The KVRN marketing messaging program is intended for people who are 18 years of age or older.
KVRN does not knowingly seek to enroll children in the marketing Program.

11. YOUR CHOICES
To stop marketing texts:
Reply STOP.
You may also communicate a reasonable revocation request to:
support@kvrn.shop
For help:
Reply HELP or contact support@kvrn.shop.
Depending on applicable law, you may also have rights to request access, deletion, or correction of personal information. Some consent or suppression records may be retained when legally or operationally necessary to continue honoring your opt-out or maintain required records.

12. CHANGES TO THIS POLICY
KVRN may update this Messaging Privacy Policy to reflect changes in law, technology, provider requirements, or the Program.
The “Last updated” date will be revised when the policy changes.
If a material change requires additional notice or consent, KVRN will provide it as required.

13. CONTACT
Questions about the KVRN messaging program or this policy may be sent to:
support@kvrn.shop`

function Policy({title, body}:{title:string;body:string}){
 const lines=body.trim().split(/\r?\n/)
 const children:ReactNode[]=[]
 let pending:string[]=[]
 const flush=()=>{
  if(pending.length){
   const group=children.length
   children.push(<ul key={'b'+group} className="list-disc space-y-1.5 pl-6 text-sm leading-7 text-neutral-700">{pending.map((v,i)=><li key={i}>{v}</li>)}</ul>)
   pending=[]
  }
 }
 lines.forEach((line,i)=>{
  const t=line.trim()
  if(!t){flush();return}
  if(t.startsWith('• ')){pending.push(t.substring(2));return}
  flush()
  if(/^\d+\.\s/.test(t))children.push(<h2 key={i} className="pt-6 text-xl font-medium tracking-tight text-neutral-900">{t}</h2>)
  else children.push(<p key={i} className="text-sm leading-7 text-neutral-700">{t}</p>)
 })
 flush()
 return <main className="container-kvrn mx-auto max-w-3xl px-5 py-12 sm:py-20">
   <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">KVRN / LEGAL</p>
   <h1 className="mt-4 text-3xl sm:text-4xl font-light tracking-tight">{title}</h1>
   <p className="mt-3 text-xs text-neutral-500">Last updated: October 6, 2026</p>
   <div className="mt-9 space-y-4">{children}</div>
   <nav aria-label="Related KVRN policies" className="mt-12 border-t border-neutral-200 pt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
     <Link className="underline" href="/terms">Store Terms</Link>
     <Link className="underline" href="/privacy">Store Privacy</Link>
     <Link className="underline" href="/messaging-terms">Messaging Terms</Link>
     <Link className="underline" href="/messaging-privacy">Messaging Privacy</Link>
     <Link className="underline" href="/sms-signup">SMS signup information</Link>
   </nav>
   <p className="mt-6 text-sm text-neutral-600">Questions? <a className="underline" href="mailto:support@kvrn.shop">support@kvrn.shop</a></p>
  </main>
}
export function MessagingTermsCopy(){return <Policy title="Messaging Terms & Conditions" body={TERMS}/>}
export function MessagingPrivacyCopy(){return <Policy title="Messaging Privacy Policy" body={PRIVACY}/>}
