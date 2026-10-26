document.addEventListener("DOMContentLoaded", function () {
    const subtitles = [
        `Some people like to call this place an atrium, which makes sense considering its nature.`,
        `You can be discoverable and miserable, or obscure and authentic.`,
        `If you have to lie, at least say half of the truth.`,
        `Welcome to the inner workings of my mind.`,
    ];

    const subHour = new Date().getUTCHours();
    const subIndex = subHour % subtitles.length;

    const dynamicSubtitle = document.getElementById("dynamic-subtitle");
    dynamicSubtitle.innerHTML = `"${subtitles[subIndex]}"`;

    //---

    const sections = document.querySelectorAll('section');
    sections.forEach(section => {
        const sectionEndHolder = document.createElement('div');
        sectionEndHolder.className = 'section-end-holder';
        sectionEndHolder.innerHTML = `
        <div class="silk-error"></div>
        <div class="section-end-text">END OF SECTION</div>
        <div class="silk-error"></div>
        `;
        section.appendChild(sectionEndHolder);
    });

    //---

    const themeMetaTag = document.querySelector('meta[name="theme-color"]');
    
    if (themeMetaTag) {
        themeMetaTag.setAttribute("content", "#000000");
    }
});