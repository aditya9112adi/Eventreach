import { Link } from 'react-router-dom';
import { ArrowLeft, MessageSquare, Moon, Sun } from 'lucide-react';
import { useTheme } from '../store/themeStore';

/**
 * Public Privacy Policy.
 *
 * Reachable without signing in, because Meta's app review has to be able to
 * open it. It describes what this application actually does — the data it
 * stores, the services it sends data to and the controls it offers — and
 * deliberately claims no certification or statutory compliance that has not
 * been verified.
 *
 * Keep it truthful: if the behaviour of the application changes, change this
 * page with it.
 */

/** Shown in the header and at the end. Update when the text below changes. */
const LAST_UPDATED = '24 September 2026';

const CONTACT_EMAIL = 'smartstacksoftwaresolution@gmail.com';

const SECTIONS = [
  { id: 'introduction', title: 'Introduction' },
  { id: 'information-we-collect', title: 'Information We Collect' },
  { id: 'how-we-use-information', title: 'How We Use Information' },
  { id: 'whatsapp-and-messaging-data', title: 'WhatsApp and Messaging Data' },
  { id: 'email-and-communication-data', title: 'Email and Communication Data' },
  { id: 'file-and-media-attachments', title: 'File and Media Attachments' },
  { id: 'data-storage-and-security', title: 'Data Storage and Security' },
  { id: 'third-party-services', title: 'Third-Party Services' },
  { id: 'data-retention', title: 'Data Retention' },
  { id: 'user-data-deletion', title: 'User Data Deletion' },
  { id: 'user-rights', title: 'Your Rights' },
  { id: 'childrens-privacy', title: "Children's Privacy" },
  { id: 'changes', title: 'Changes to This Privacy Policy' },
  { id: 'contact', title: 'Contact Information' },
];

const Section = ({
  id,
  title,
  index,
  children,
}: {
  id: string;
  title: string;
  index: number;
  children: React.ReactNode;
}) => (
  <section id={id} className="scroll-mt-24">
    <h2 className="text-lg sm:text-xl font-sans font-bold text-foreground tracking-wide">
      <span className="text-foreground/40 mr-2">{index}.</span>
      {title}
    </h2>
    <div className="mt-3 space-y-3 text-sm sm:text-[15px] leading-relaxed text-foreground/75">
      {children}
    </div>
  </section>
);

const Bullets = ({ items }: { items: React.ReactNode[] }) => (
  <ul className="list-disc space-y-2 pl-5 marker:text-foreground/30">
    {items.map((item, i) => (
      <li key={i}>{item}</li>
    ))}
  </ul>
);

const External = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="text-accent hover:text-accent/80 underline underline-offset-2 transition-colors"
  >
    {children}
  </a>
);

const MailLink = () => (
  <a
    href={`mailto:${CONTACT_EMAIL}`}
    className="text-accent hover:text-accent/80 underline underline-offset-2 break-all transition-colors"
  >
    {CONTACT_EMAIL}
  </a>
);

const PrivacyPolicy = () => {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link to="/login" className="flex min-w-0 items-center gap-2.5 group">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <MessageSquare className="h-4 w-4" />
            </span>
            <span className="truncate font-sans text-sm font-bold uppercase tracking-wider text-foreground">
              EventReach
            </span>
          </Link>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="rounded-full p-2 text-foreground/50 transition-colors hover:bg-surfaceHover hover:text-foreground"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <Link
              to="/login"
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-foreground/70 transition-colors hover:bg-surfaceHover hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back to Login</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        <h1 className="text-2xl font-sans font-bold uppercase tracking-wider text-foreground sm:text-3xl">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-foreground/50">Last updated: {LAST_UPDATED}</p>

        {/* Contents */}
        <nav aria-label="Contents" className="mt-8 rounded-xl border border-border bg-surface p-5">
          <h2 className="text-xs font-sans font-bold uppercase tracking-wider text-foreground/50">
            Contents
          </h2>
          <ol className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {SECTIONS.map((section, i) => (
              <li key={section.id} className="text-sm">
                <a
                  href={`#${section.id}`}
                  className="text-foreground/70 transition-colors hover:text-accent"
                >
                  <span className="text-foreground/35">{i + 1}.</span> {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="mt-10 space-y-10">
          <Section id="introduction" title="Introduction" index={1}>
            <p>
              EventReach is an event management platform. Event organizers use it to create events,
              keep a list of the guests they intend to invite, compose messages, send those messages
              over WhatsApp, and see what happened to each one.
            </p>
            <p>
              This policy explains what information the platform stores, why it stores it, who it is
              shared with, and how it can be removed. It applies to the EventReach web application
              and its backend service.
            </p>
            <p className="rounded-lg border border-border bg-surface p-4">
              <strong className="font-semibold text-foreground">Two kinds of people are described here.</strong>{' '}
              <em>Organizers</em> hold an EventReach account and sign in. <em>Guests</em> do not —
              their names and phone numbers are entered or imported by an organizer so that the
              organizer can message them. An organizer who uploads guest details is responsible for
              having a proper basis to contact those people, and for honouring any request from a
              guest to stop.
            </p>
          </Section>

          <Section id="information-we-collect" title="Information We Collect" index={2}>
            <p className="font-medium text-foreground/90">Account information (organizers)</p>
            <Bullets
              items={[
                'Name, email address and role (Super Admin, Admin or User).',
                'A password, stored only as a bcrypt hash — the plain password is never stored and cannot be recovered from what is kept.',
                'Account status and, where an administrator has set one, the dates between which access is granted.',
                'Password reset tokens, which are time limited and single purpose.',
              ]}
            />

            <p className="pt-2 font-medium text-foreground/90">Event and guest information</p>
            <Bullets
              items={[
                'Event details: name, type, date, time, venue, organizer name and organizer mobile number.',
                'Guest details entered or imported by an organizer: full name, phone number and country code, along with any tags, the import source, and whether the number was recognised as valid.',
              ]}
            />

            <p className="pt-2 font-medium text-foreground/90">Message and delivery information</p>
            <Bullets
              items={[
                'The message text an organizer composes, and any files attached to it.',
                'A per-recipient delivery record: the recipient name and number, the message identifier returned by WhatsApp, the status, timestamps for acceptance, delivery and read, and any error code and reason reported back.',
              ]}
            />

            <p className="pt-2 font-medium text-foreground/90">Security and activity information</p>
            <Bullets
              items={[
                'Audit records of significant actions — who did what, to which record, and what changed. Values recognised as sensitive, such as passwords and tokens, are redacted before an audit record is written.',
                'Request details attached to those records: IP address, browser user agent, HTTP method, endpoint and a request identifier.',
                'A session token is held in your browser so you stay signed in.',
              ]}
            />
            <p>
              The platform does not use advertising trackers, and does not sell personal information.
            </p>
          </Section>

          <Section id="how-we-use-information" title="How We Use Information" index={3}>
            <Bullets
              items={[
                'To run the service: signing you in, showing your events and guests, and keeping your data separated from other organizers.',
                'To deliver the messages an organizer chooses to send, and to report back what happened to each one.',
                'To enforce access rules — role based permissions, per event access, and administrator approval of new accounts.',
                'To keep the service secure and accountable: audit records, rate limiting, and investigation of abuse or errors.',
                'To send the small number of service emails described below.',
                'To diagnose faults. Where a failure is logged, the platform records the provider’s error information, not credentials or message contents.',
              ]}
            />
            <p>
              Information is not used for advertising, profiling or automated decision-making about
              individuals.
            </p>
          </Section>

          <Section id="whatsapp-and-messaging-data" title="WhatsApp and Messaging Data" index={4}>
            <p>
              Messages are sent through the WhatsApp Business Platform (Cloud API), operated by Meta.
              To deliver a message, EventReach sends Meta the recipient’s phone number, the message
              content, and any attachment. Meta processes that information under its own terms; see
              the <External href="https://www.whatsapp.com/legal/business-data-transfer-addendum">WhatsApp Business Data Transfer Addendum</External>{' '}
              and the <External href="https://www.facebook.com/privacy/policy/">Meta Privacy Policy</External>.
            </p>
            <Bullets
              items={[
                'Two kinds of message are supported: a free-form message an organizer writes, and a message template that Meta has reviewed and approved in advance. Template values are filled in on the server from the event and the guest record.',
                'WhatsApp returns a message identifier for every accepted message. It is stored so that later status updates can be matched to the right recipient.',
                'Meta sends delivery status callbacks — sent, delivered, read or failed — to the EventReach backend. Those callbacks are authenticated before they are accepted, and are used to update the delivery report.',
                'WhatsApp access credentials are held only on the server. They are never sent to the browser, never written to logs, and never included in an error shown in the application.',
              ]}
            />
            <p>
              A guest who does not want to receive further messages should tell the organizer who
              contacted them, and can also block or report the sending number inside WhatsApp itself.
              EventReach does not currently process automated opt-out keywords, so a request made by
              replying may not be seen by the organizer.
            </p>
          </Section>

          <Section id="email-and-communication-data" title="Email and Communication Data" index={5}>
            <p>
              Email is used only for running accounts — password reset links, and notifications to
              administrators about accounts awaiting approval and the outcome of that approval. There
              are no marketing emails, and guests are not emailed.
            </p>
            <p>
              In production, email is delivered through Resend. In local development it may be sent
              through an SMTP provider instead. The email address and the contents of that message
              are handled by whichever provider sends it.
            </p>
          </Section>

          <Section id="file-and-media-attachments" title="File and Media Attachments" index={6}>
            <Bullets
              items={[
                'Organizers can attach images, video, audio and PDF documents to a message, within the size limits WhatsApp accepts for each type.',
                'An uploaded file is checked before it is accepted: its contents must genuinely match the type it claims to be, so a file that has merely been renamed is rejected.',
                'Files are stored on the application server, not in a public bucket. They are served only to a signed-in user who has access to the event the file belongs to.',
                'To deliver an attachment, the file is uploaded to Meta, which returns an identifier used to send it. The file is never given to WhatsApp as a public link. Meta keeps uploaded media for a limited period under its own retention rules.',
                'The server’s file storage is not permanent: on the current hosting plan, uploaded files may be removed when the service restarts or is redeployed. An attachment should be treated as short lived, and re-uploaded if it is needed again.',
              ]}
            />
          </Section>

          <Section id="data-storage-and-security" title="Data Storage and Security" index={7}>
            <p>Data is stored in MongoDB Atlas. The application takes these measures:</p>
            <Bullets
              items={[
                'Traffic between your browser and the service is encrypted in transit (HTTPS).',
                'Passwords are stored as bcrypt hashes, never in readable form.',
                'Access is controlled by signed session tokens, by role, and per event, and is checked on the server for every request rather than only hidden in the interface.',
                'Incoming WhatsApp callbacks are verified with a cryptographic signature before anything is written.',
                'Requests are rate limited, input is sanitised, and standard security headers are applied.',
                'Significant actions are recorded in an audit log with sensitive values redacted.',
              ]}
            />
            <p>
              No online service can promise perfect security, and this policy does not claim any
              certification, audit or statutory compliance that has not been carried out. If you
              believe an account or data has been exposed, please write to <MailLink /> so it can be
              looked into.
            </p>
          </Section>

          <Section id="third-party-services" title="Third-Party Services" index={8}>
            <p>
              EventReach relies on the following providers. Each processes only what is needed for
              its part of the service, under its own privacy terms.
            </p>
            <Bullets
              items={[
                <>
                  <strong className="font-semibold text-foreground">Meta (WhatsApp Business Platform)</strong> —
                  message delivery and delivery status.{' '}
                  <External href="https://www.facebook.com/privacy/policy/">Privacy Policy</External>
                </>,
                <>
                  <strong className="font-semibold text-foreground">MongoDB Atlas</strong> — database hosting.{' '}
                  <External href="https://www.mongodb.com/legal/privacy-policy">Privacy Policy</External>
                </>,
                <>
                  <strong className="font-semibold text-foreground">Render</strong> — backend hosting.{' '}
                  <External href="https://render.com/privacy">Privacy Policy</External>
                </>,
                <>
                  <strong className="font-semibold text-foreground">Vercel</strong> — frontend hosting.{' '}
                  <External href="https://vercel.com/legal/privacy-policy">Privacy Policy</External>
                </>,
                <>
                  <strong className="font-semibold text-foreground">Resend</strong> — transactional email delivery.{' '}
                  <External href="https://resend.com/legal/privacy-policy">Privacy Policy</External>
                </>,
              ]}
            />
            <p>
              Because these providers operate internationally, information may be processed outside
              the country where you live.
            </p>
          </Section>

          <Section id="data-retention" title="Data Retention" index={9}>
            <Bullets
              items={[
                'Account, event, guest and campaign data is kept until it is deleted in the application or the account is removed. No automatic expiry is applied to it.',
                'Deleting an event also deletes the guest records belonging to that event.',
                'Delivery records and audit records are kept so that reporting and security history remain meaningful after the fact.',
                'Uploaded files are, as described above, short lived on the server, and copies held by Meta expire under Meta’s own retention rules.',
                'Password reset tokens expire after a short, configured period.',
              ]}
            />
          </Section>

          <Section id="user-data-deletion" title="User Data Deletion" index={10}>
            <p className="font-medium text-foreground/90">In the application</p>
            <Bullets
              items={[
                'An organizer with the necessary permission can delete guests individually or in bulk, and can delete an event — which also removes that event’s guests.',
                'Audit records are deliberately not deletable from the interface, because a log that can be edited by the people it records is not a log.',
              ]}
            />
            <p className="pt-2 font-medium text-foreground/90">By request</p>
            <p>
              To have an account and its associated data removed, or to ask for the deletion of a
              specific person’s details, email <MailLink /> from the address associated with the
              account, or — if you are a guest — include the phone number concerned and the name of
              the organizer who contacted you. Requests are actioned manually; you will receive a
              reply confirming what was removed.
            </p>
            <p>
              Deletion covers the data held by EventReach. Messages already delivered to a
              recipient’s phone cannot be recalled, and records held by Meta are governed by Meta’s
              own retention and deletion process.
            </p>
          </Section>

          <Section id="user-rights" title="Your Rights" index={11}>
            <p>
              Depending on where you live, you may have rights over your personal information —
              typically to ask what is held, to have it corrected, to have it deleted, or to object
              to how it is used. This policy does not assert compliance with any particular statute,
              but requests of this kind are honoured as described here:
            </p>
            <Bullets
              items={[
                'Organizers can view and correct their own account details, events, guests and messages directly in the application.',
                'Anything not editable in the application — including a request from a guest, who has no account — can be asked for by emailing the address below.',
                'Enough information is needed to locate the records in question and to be satisfied that the request is genuine.',
              ]}
            />
          </Section>

          <Section id="childrens-privacy" title="Children's Privacy" index={12}>
            <p>
              EventReach is a tool for event organizers and is not directed at children. Accounts are
              not knowingly created for anyone under 13, and information about children is not
              knowingly collected. If you believe a child’s information has been entered — for
              example as a guest on an event — write to <MailLink /> and it will be removed.
            </p>
          </Section>

          <Section id="changes" title="Changes to This Privacy Policy" index={13}>
            <p>
              This policy will be updated when the application changes in a way that affects it. The
              date at the top of the page shows when it was last revised. Where a change materially
              affects how personal information is handled, signed-in organizers will be notified in
              the application or by email. Continuing to use EventReach after a change means the
              updated policy applies.
            </p>
          </Section>

          <Section id="contact" title="Contact Information" index={14}>
            <p>
              For any question about this policy, about the information held about you, or to make a
              deletion request, contact:
            </p>
            <p className="rounded-lg border border-border bg-surface p-4">
              <span className="block text-xs font-sans font-bold uppercase tracking-wider text-foreground/50">
                EventReach — Privacy
              </span>
              <span className="mt-2 block">
                <MailLink />
              </span>
            </p>
            <p>
              Please allow a reasonable period for a reply, and include enough detail for the records
              concerned to be found.
            </p>
          </Section>
        </div>

        <footer className="mt-12 border-t border-border pt-6 text-sm text-foreground/50">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>Last updated: {LAST_UPDATED}</span>
            <Link to="/login" className="font-medium text-accent transition-colors hover:text-accent/80">
              Return to EventReach
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
};

export default PrivacyPolicy;
