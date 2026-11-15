import { useTranslation } from 'react-i18next';
import { Search, MessageSquare, Plug, Server, ExternalLink } from 'lucide-react';

const FEATURE_ICONS = [Search, MessageSquare, Plug, Server];

export default function AboutPage() {
  const { t } = useTranslation();

  const hero = t('about.hero', { returnObjects: true });
  const features = t('about.features.items', { returnObjects: true });
  const stack = t('about.stack.items', { returnObjects: true });
  const contact = t('about.contact', { returnObjects: true });

  const isExternal = (url) => typeof url === 'string' && url.startsWith('http');

  return (
    <div className="about-page">
      <div className="about">
        {/* Hero */}
        <section className="about__hero">
          <h1 className="about__name">{hero.name}</h1>
          <p className="about__role">{hero.role}</p>
          <p className="about__intro">{hero.intro1}</p>
          <p className="about__intro">{hero.intro2}</p>
        </section>

        {/* Features */}
        <section className="about__section">
          <h2 className="about__section-title">{t('about.features.title')}</h2>
          <div className="about__what-grid">
            {features.map((item, i) => {
              const Icon = FEATURE_ICONS[i] || Server;
              return (
                <article key={item.title} className="about__what-card">
                  <span className="about__what-icon">
                    <Icon size={20} />
                  </span>
                  <h3 className="about__what-title">{item.title}</h3>
                  <p className="about__what-desc">{item.desc}</p>
                </article>
              );
            })}
          </div>
        </section>

        {/* Tech Stack */}
        <section className="about__section">
          <h2 className="about__section-title">{t('about.stack.title')}</h2>
          <ul className="about__tags">
            {stack.map((tech) => (
              <li key={tech} className="about__tag about__tag--tech">
                {tech}
              </li>
            ))}
          </ul>
        </section>

        {/* Contact */}
        <section className="about__section">
          <h2 className="about__section-title">{t('about.contact.title')}</h2>
          <ul className="about__contact-list">
            {contact.links.map((link) => (
              <li key={link.label}>
                <a
                  href={link.url}
                  target={isExternal(link.url) ? '_blank' : undefined}
                  rel={isExternal(link.url) ? 'noreferrer' : undefined}
                  className="about__contact-link"
                >
                  <ExternalLink size={16} />
                  <span>{link.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
